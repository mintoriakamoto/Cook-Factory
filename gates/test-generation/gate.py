#!/usr/bin/env python3
"""Tier-1 RELATIONAL gate for the test-generation pack (MILESTONE v1.9 Wave 3).

Scores a Python test-suite deliverable BY ITS RELATIONSHIP to the module under
test: the suite is never inspected for style, it is measured for discrimination.

Usage: gate.py <bundle.json>  - prints v2 FAIL lines + `gate: N/6`, exit 0 iff all pass.

The artifact is an orchestrator-constructed JSON bundle:
  {
    "schema": "ferrox.test-generation.bundle/1",
    "target":   { "filename": "intervals.py",      "source": "<python>" },
    "suite":    { "filename": "test_intervals.py", "source": "<python>" },
    "smoke":    [ "merge_intervals([])", ... ],
    "declared": { "kill_threshold": 0.7, "coverage_baseline": 40.0,
                  "coverage_min_delta": 25.0 }
  }
The suite source is the only builder-authored member; target, smoke probes, and
declared thresholds come from the trusted orchestrator side.

Checks (spec-clause order, categories from the closed 6-enum):
  TG-01 relation   mutation kill rate on per-run sampled AST mutants >= declared
                   kill_threshold. Self-contained stdlib-ast mutation engine
                   (operator swaps, comparison boundary shifts, integer constant
                   perturbation, branch deletion, boolean operator swaps).
                   Mutants that crash the orchestrator smoke probes are pruned as
                   trivial (killed by mere execution, zero discrimination signal),
                   so every pool member requires a real assertion to catch.
                   Per-run sample of MUTANT_SAMPLE_K seeded exactly like Wave 1
                   mutant-rotation: seed0 = sha256(runId + ":" + gateId),
                   candidates sorted by content hash, draw i = uint64BE(
                   sha256(seed0 || uint32BE(i))[0:8]) mod remaining.
                   runId comes from env FERROX_RUN_ID (fallback "unrotated").
  TG-02 relation   executed-line coverage of the target during the suite run,
                   minus declared coverage_baseline, >= declared
                   coverage_min_delta points. Uses coverage.py when importable,
                   degrades gracefully to the stdlib trace module; both feed the
                   same AST-derived executable-line denominator so the metric is
                   tool-stable.
  TG-03 structure  zero assert-free test functions (AST scan). An assert whose
                   test is a bare literal constant (`assert True`) counts as no
                   assert at all.
  TG-04 value      zero self-comparing asserts (AST scan): `assert x == x`
                   shapes and assertEqual-family calls whose 2 sides are the
                   identical expression.
  TG-05 execution  the suite passes against the unmutated target (subprocess
                   unittest run; zero collected tests fails via unittest exit 5).
  TG-06 security   the suite neither mutates nor monkeypatches the target
                   module: static scan for target-attribute assignment, setattr
                   on the target, mock.patch/patch.object aimed at the target,
                   and file-write channels; plus a runtime hash of the target
                   source before/after the TG-05 run.

Output contract v2 (ADR-SEALED-GATES decision 3): `FAIL <ID> <category>` per
failing check, summary `gate: N/6` last. Diagnostics go to stderr only.
Orchestrator-authored; stdlib only (coverage.py optional); fail-closed.
"""
import ast
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

GATE_ID = "test-generation"
MUTANT_SAMPLE_K = 8
SUBPROCESS_TIMEOUT_S = 60
SMOKE_TIMEOUT_S = 5

CHECKS = [
    ("TG-01", "relation"),
    ("TG-02", "relation"),
    ("TG-03", "structure"),
    ("TG-04", "value"),
    ("TG-05", "execution"),
    ("TG-06", "security"),
]

# ---------------------------------------------------------------- diagnostics

def note(msg):
    print(msg, file=sys.stderr)

# ------------------------------------------------------------- bundle loading

def load_bundle(path):
    """Parse and shape-check the bundle. Returns (bundle, error_string)."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError) as exc:
        return None, "bundle unreadable: %s" % exc
    if not isinstance(raw, dict):
        return None, "bundle is not an object"
    for part in ("target", "suite"):
        member = raw.get(part)
        if not (isinstance(member, dict)
                and isinstance(member.get("filename"), str)
                and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*\.py", member["filename"])
                and isinstance(member.get("source"), str)):
            return None, "bundle member %r malformed" % part
    declared = raw.get("declared")
    if not isinstance(declared, dict):
        return None, "bundle member 'declared' malformed"
    for key in ("kill_threshold", "coverage_baseline", "coverage_min_delta"):
        if not isinstance(declared.get(key), (int, float)):
            return None, "declared.%s missing or non-numeric" % key
    smoke = raw.get("smoke")
    if not (isinstance(smoke, list) and all(isinstance(s, str) for s in smoke)):
        return None, "bundle member 'smoke' malformed"
    return raw, None

# ----------------------------------------------------------- AST scan helpers

def call_name(func):
    """The trailing name of a call target: Name id or Attribute attr."""
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return None

def iter_test_functions(tree):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test"):
            yield node

def has_meaningful_assert(func):
    """True when the test function carries at least 1 non-vacuous assertion."""
    for node in ast.walk(func):
        if isinstance(node, ast.Assert):
            if not isinstance(node.test, ast.Constant):
                return True
        elif isinstance(node, ast.Call):
            name = call_name(node.func)
            if name is not None and (name.startswith("assert") or name == "raises"):
                return True
    return False

def assert_free_test_functions(tree):
    return [f.name for f in iter_test_functions(tree) if not has_meaningful_assert(f)]

SELF_EQ_METHODS = {
    "assertEqual", "assertIs", "assertAlmostEqual", "assertListEqual",
    "assertDictEqual", "assertSetEqual", "assertTupleEqual",
    "assertSequenceEqual", "assertCountEqual",
}

def self_comparing_asserts(tree):
    """Count `x == x` compare shapes and assertEqual(x, x) style calls."""
    hits = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare) and node.comparators:
            if ast.dump(node.left) == ast.dump(node.comparators[0]):
                hits += 1
        elif isinstance(node, ast.Call):
            name = call_name(node.func)
            if name in SELF_EQ_METHODS and len(node.args) >= 2:
                if ast.dump(node.args[0]) == ast.dump(node.args[1]):
                    hits += 1
    return hits

def target_aliases(tree, target_module):
    """Names the suite binds to the target module object itself."""
    aliases = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for item in node.names:
                if item.name == target_module or item.name.startswith(target_module + "."):
                    aliases.add((item.asname or item.name).split(".")[0])
    return aliases

WRITE_MODE_RE = re.compile(r"[wax+]")
FILE_WRITE_ATTRS = {"write_text", "write_bytes"}

def tamper_findings(tree, target_module):
    """Static TG-06 scan: ways a suite mutates or monkeypatches the target."""
    aliases = target_aliases(tree, target_module)
    findings = []

    def is_alias_attr(node):
        return (isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and node.value.id in aliases)

    def str_hits_target(node):
        return (isinstance(node, ast.Constant) and isinstance(node.value, str)
                and (node.value == target_module or node.value.startswith(target_module + ".")))

    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign, ast.Delete)):
            targets = node.targets if isinstance(node, (ast.Assign, ast.Delete)) else [node.target]
            if any(is_alias_attr(t) for t in targets):
                findings.append("assignment to a target module attribute")
        elif isinstance(node, ast.Call):
            name = call_name(node.func)
            args = node.args
            if name in ("setattr", "delattr") and args:
                if (isinstance(args[0], ast.Name) and args[0].id in aliases) or str_hits_target(args[0]):
                    findings.append("%s aimed at the target module" % name)
            elif name == "patch" and args and str_hits_target(args[0]):
                findings.append("mock.patch aimed at the target module")
            elif name == "object" and isinstance(node.func, ast.Attribute) \
                    and call_name(node.func.value) == "patch" and args \
                    and isinstance(args[0], ast.Name) and args[0].id in aliases:
                findings.append("mock.patch.object aimed at the target module")
            elif name == "open":
                mode = None
                if len(args) >= 2 and isinstance(args[1], ast.Constant) and isinstance(args[1].value, str):
                    mode = args[1].value
                for kw in node.keywords:
                    if kw.arg == "mode" and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                        mode = kw.value.value
                if mode is not None and WRITE_MODE_RE.search(mode):
                    findings.append("open() with a write-capable mode")
            elif name in FILE_WRITE_ATTRS:
                findings.append("file write via %s" % name)
    return findings

def executable_lines(source):
    """AST-derived executable-line denominator: statement linenos minus docstrings."""
    lines = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.stmt):
            if (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
                    and isinstance(node.value.value, str)):
                continue
            lines.add(node.lineno)
    return lines

# ---------------------------------------------------------- mutation engine

COMPARE_SWAP = {
    ast.Lt: ast.LtE, ast.LtE: ast.Lt,
    ast.Gt: ast.GtE, ast.GtE: ast.Gt,
    ast.Eq: ast.NotEq, ast.NotEq: ast.Eq,
}
BINOP_SWAP = {
    ast.Add: ast.Sub, ast.Sub: ast.Add,
    ast.Mult: ast.Add, ast.Div: ast.Mult,
    ast.FloorDiv: ast.Div, ast.Mod: ast.Sub,
}

def _count_sites(tree):
    counts = {"compare": 0, "binop": 0, "const": 0, "branch": 0, "boolop": 0}
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare) and type(node.ops[0]) in COMPARE_SWAP:
            counts["compare"] += 1
        elif isinstance(node, ast.BinOp) and type(node.op) in BINOP_SWAP:
            counts["binop"] += 1
        elif isinstance(node, ast.Constant) and isinstance(node.value, int) \
                and not isinstance(node.value, bool):
            counts["const"] += 1
        elif isinstance(node, ast.If):
            counts["branch"] += 1
        elif isinstance(node, ast.BoolOp):
            counts["boolop"] += 1
    return counts

def _mutate_nth(tree, kind, index):
    """Apply the index-th mutation of the given kind to a fresh tree copy."""
    seen = 0
    for node in ast.walk(tree):
        if kind == "compare" and isinstance(node, ast.Compare) and type(node.ops[0]) in COMPARE_SWAP:
            if seen == index:
                node.ops[0] = COMPARE_SWAP[type(node.ops[0])]()
                return True
            seen += 1
        elif kind == "binop" and isinstance(node, ast.BinOp) and type(node.op) in BINOP_SWAP:
            if seen == index:
                node.op = BINOP_SWAP[type(node.op)]()
                return True
            seen += 1
        elif kind == "const" and isinstance(node, ast.Constant) and isinstance(node.value, int) \
                and not isinstance(node.value, bool):
            if seen == index:
                node.value = node.value + 1
                return True
            seen += 1
        elif kind == "branch" and isinstance(node, ast.If):
            if seen == index:
                node.test = ast.Constant(value=False)
                return True
            seen += 1
        elif kind == "boolop" and isinstance(node, ast.BoolOp):
            if seen == index:
                node.op = ast.Or() if isinstance(node.op, ast.And) else ast.And()
                return True
            seen += 1
    return False

def generate_mutants(target_source):
    """Every single-site mutant of the target: deduped, compile-checked."""
    base_tree = ast.parse(target_source)
    base_unparsed = ast.unparse(base_tree)
    mutants = []
    seen_sources = set()
    for kind, total in sorted(_count_sites(base_tree).items()):
        for index in range(total):
            tree = copy.deepcopy(base_tree)
            if not _mutate_nth(tree, kind, index):
                continue
            ast.fix_missing_locations(tree)
            try:
                source = ast.unparse(tree)
                compile(source, "<mutant>", "exec")
            except (SyntaxError, ValueError):
                continue
            if source == base_unparsed or source in seen_sources:
                continue
            seen_sources.add(source)
            mutants.append({
                "kind": kind,
                "index": index,
                "source": source,
                "hash": hashlib.sha256(source.encode("utf-8")).hexdigest(),
            })
    return mutants

def smoke_survives(module_source, smoke_calls):
    """True when the module imports and every smoke probe runs without raising.

    Used 2 ways: sanity on the pristine target, and pruning of trivial mutants
    (a mutant that crashes the probes is killed by mere execution and carries
    zero discrimination signal, so it must not occupy a pool slot).
    """
    namespace = {}
    old_alarm = None
    try:
        if hasattr(__import__("signal"), "SIGALRM"):
            import signal

            def _timeout(_signum, _frame):
                raise TimeoutError("smoke probe timeout")

            old_alarm = signal.signal(signal.SIGALRM, _timeout)
            signal.alarm(SMOKE_TIMEOUT_S)
        # SECURITY: exec/eval are deliberate and in-trust-boundary. module_source is
        # the orchestrator-authored target (or a gate-generated mutant of it) and
        # smoke_calls are orchestrator-authored probe expressions from the bundle the
        # orchestrator constructs; NO builder-authored code flows through here (the
        # builder's suite runs only in isolated subprocesses). Executing this code is
        # the gate's purpose: probing whether a mutant crashes on benign inputs.
        exec(compile(module_source, "<smoke-module>", "exec"), namespace)  # noqa: S102 - orchestrator-authored target
        for probe in smoke_calls:
            eval(compile(probe, "<smoke-probe>", "eval"), namespace)  # noqa: S307 - orchestrator-authored probes
        return True
    except BaseException:
        return False
    finally:
        if old_alarm is not None:
            import signal
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_alarm)

def sample_mutants(run_id, gate_id, pool, k):
    """The Wave 1 rotation algorithm (ADR-SEALED-GATES decision 2), byte-for-byte.

    seed0 = sha256(runId + ":" + gateId); candidates sorted by content hash;
    draw i = uint64BE(sha256(seed0 || uint32BE(i))[0:8]) mod remaining.
    """
    seed0 = hashlib.sha256(("%s:%s" % (run_id, gate_id)).encode("utf-8")).digest()
    remaining = sorted(pool, key=lambda m: m["hash"])
    sampled = []
    for i in range(min(k, len(remaining))):
        draw = hashlib.sha256(seed0 + i.to_bytes(4, "big")).digest()
        u = int.from_bytes(draw[:8], "big")
        sampled.append(remaining.pop(u % len(remaining)))
    return sampled

# ------------------------------------------------------------ subprocess runs

def run_suite_subprocess(target_filename, target_source, suite_filename, suite_source):
    """Run the suite against the given target source in a fresh directory.

    Returns (passed, target_bytes_after) where passed is True iff unittest
    exited 0 (exit 5 = zero tests collected = fail; timeout = fail).
    """
    run_dir = tempfile.mkdtemp(prefix="tg-gate-run-")
    try:
        target_path = os.path.join(run_dir, target_filename)
        with open(target_path, "w", encoding="utf-8") as fh:
            fh.write(target_source)
        with open(os.path.join(run_dir, suite_filename), "w", encoding="utf-8") as fh:
            fh.write(suite_source)
        module = suite_filename[:-3]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        try:
            proc = subprocess.run(
                [sys.executable, "-B", "-m", "unittest", "-q", module],
                cwd=run_dir, env=env, capture_output=True,
                timeout=SUBPROCESS_TIMEOUT_S, check=False,
            )
            passed = proc.returncode == 0
        except subprocess.TimeoutExpired:
            passed = False
        with open(target_path, "rb") as fh:
            after = fh.read()
        return passed, after
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)

COVERAGE_RUNNER_SOURCE = '''\
"""Executed-line reporter: coverage.py when importable, stdlib trace fallback."""
import io
import json
import os
import sys
import unittest


def run_suite(module_name):
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromName(module_name)
    unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(suite)


def main():
    target_file = os.path.abspath(sys.argv[1])
    module_name = sys.argv[2]
    mode = sys.argv[3] if len(sys.argv) > 3 else "auto"
    sys.path.insert(0, os.path.dirname(target_file))
    coverage = None
    if mode != "trace":
        try:
            import coverage as coverage_module
            coverage = coverage_module
        except ImportError:
            coverage = None
    executed = set()
    if coverage is not None:
        cov = coverage.Coverage(data_file=None, include=[target_file])
        cov.start()
        run_suite(module_name)
        cov.stop()
        data = cov.get_data()
        for measured in data.measured_files():
            if os.path.basename(measured) == os.path.basename(target_file):
                executed.update(data.lines(measured) or [])
    else:
        import trace
        tracer = trace.Trace(count=1, trace=0)
        tracer.runfunc(run_suite, module_name)
        for (filename, lineno), hits in tracer.results().counts.items():
            if os.path.basename(filename) == os.path.basename(target_file) and hits > 0:
                executed.add(lineno)
    print(json.dumps(sorted(executed)))


main()
'''

def measure_coverage(target_filename, target_source, suite_filename, suite_source):
    """Executed-line coverage percent of the target, or None on runner failure."""
    run_dir = tempfile.mkdtemp(prefix="tg-gate-cov-")
    try:
        with open(os.path.join(run_dir, target_filename), "w", encoding="utf-8") as fh:
            fh.write(target_source)
        with open(os.path.join(run_dir, suite_filename), "w", encoding="utf-8") as fh:
            fh.write(suite_source)
        runner_path = os.path.join(run_dir, "_tg_coverage_runner.py")
        with open(runner_path, "w", encoding="utf-8") as fh:
            fh.write(COVERAGE_RUNNER_SOURCE)
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        try:
            proc = subprocess.run(
                [sys.executable, "-B", runner_path, target_filename, suite_filename[:-3]],
                cwd=run_dir, env=env, capture_output=True, text=True,
                timeout=SUBPROCESS_TIMEOUT_S * 2, check=False,
            )
        except subprocess.TimeoutExpired:
            return None
        if proc.returncode != 0:
            note("coverage runner failed: %s" % proc.stderr.strip()[:400])
            return None
        try:
            executed = set(json.loads(proc.stdout.strip().splitlines()[-1]))
        except (ValueError, IndexError):
            return None
        denominator = executable_lines(target_source)
        if not denominator:
            return None
        return 100.0 * len(executed & denominator) / len(denominator)
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)

# --------------------------------------------------------------------- main

def main(argv):
    if len(argv) != 2:
        note("usage: gate.py <bundle.json>")
        print("gate: 0/%d" % len(CHECKS))
        return 2

    results = {check_id: False for check_id, _ in CHECKS}

    def finish():
        passed = sum(1 for ok in results.values() if ok)
        for check_id, category in CHECKS:
            if not results[check_id]:
                print("FAIL %s %s" % (check_id, category))
        print("gate: %d/%d" % (passed, len(CHECKS)))
        return 0 if passed == len(CHECKS) else 2

    bundle, err = load_bundle(argv[1])
    if bundle is None:
        note("bundle rejected: %s" % err)
        return finish()

    target = bundle["target"]
    suite = bundle["suite"]
    declared = bundle["declared"]
    smoke = bundle["smoke"]
    target_module = target["filename"][:-3]

    try:
        suite_tree = ast.parse(suite["source"])
        ast.parse(target["source"])
    except SyntaxError as exc:
        note("source rejected: %s" % exc)
        return finish()

    # TG-03: zero assert-free test functions.
    assert_free = assert_free_test_functions(suite_tree)
    results["TG-03"] = len(assert_free) == 0
    if assert_free:
        note("TG-03 assert-free test functions: %s" % ", ".join(assert_free))

    # TG-04: zero self-comparing asserts.
    self_compares = self_comparing_asserts(suite_tree)
    results["TG-04"] = self_compares == 0
    if self_compares:
        note("TG-04 self-comparing asserts: %d" % self_compares)

    # TG-06 static half: no mutation or monkeypatching of the target.
    findings = tamper_findings(suite_tree, target_module)
    for finding in findings:
        note("TG-06 %s" % finding)

    # TG-05: the suite passes against the pristine target (runtime TG-06 rides along).
    target_hash_before = hashlib.sha256(target["source"].encode("utf-8")).hexdigest()
    suite_passed, target_after = run_suite_subprocess(
        target["filename"], target["source"], suite["filename"], suite["source"])
    results["TG-05"] = suite_passed
    runtime_tampered = hashlib.sha256(target_after).hexdigest() != target_hash_before
    if runtime_tampered:
        note("TG-06 target source changed during the suite run")
    results["TG-06"] = len(findings) == 0 and not runtime_tampered

    # TG-02: coverage delta vs the declared baseline.
    coverage_pct = measure_coverage(
        target["filename"], target["source"], suite["filename"], suite["source"])
    if coverage_pct is None:
        note("TG-02 coverage unmeasurable: fail closed")
        results["TG-02"] = False
    else:
        delta = coverage_pct - float(declared["coverage_baseline"])
        results["TG-02"] = delta >= float(declared["coverage_min_delta"])
        note("TG-02 coverage %.1f%% (baseline %.1f, delta %.1f, need >= %.1f)"
             % (coverage_pct, declared["coverage_baseline"], delta, declared["coverage_min_delta"]))

    # TG-01: mutation kill rate on the per-run sample. Meaningless unless the
    # suite is green on the pristine target (a failing suite "kills" everything).
    if not suite_passed:
        note("TG-01 skipped kill measurement: suite is not green on the pristine target")
        results["TG-01"] = False
    elif not smoke_survives(target["source"], smoke):
        note("TG-01 pristine target fails its own smoke probes: bundle rejected")
        results["TG-01"] = False
    else:
        pool = [m for m in generate_mutants(target["source"])
                if smoke_survives(m["source"], smoke)]
        if not pool:
            note("TG-01 empty mutant pool after trivial-mutant pruning: fail closed")
            results["TG-01"] = False
        else:
            run_id = os.environ.get("FERROX_RUN_ID", "") or "unrotated"
            sampled = sample_mutants(run_id, GATE_ID, pool, MUTANT_SAMPLE_K)
            kills = 0
            for mutant in sampled:
                mutant_green, _ = run_suite_subprocess(
                    target["filename"], mutant["source"], suite["filename"], suite["source"])
                if not mutant_green:
                    kills += 1
            rate = kills / len(sampled)
            results["TG-01"] = rate >= float(declared["kill_threshold"])
            note("TG-01 run %s: pool %d, sampled %d [%s], kills %d, rate %.2f, need >= %.2f"
                 % (run_id, len(pool), len(sampled),
                    " ".join("%s#%d" % (m["kind"], m["index"]) for m in sampled),
                    kills, rate, declared["kill_threshold"]))

    return finish()

if __name__ == "__main__":
    sys.exit(main(sys.argv))
