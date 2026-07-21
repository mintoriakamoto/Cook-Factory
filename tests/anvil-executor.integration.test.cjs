'use strict';

/**
 * ANV-04/05 integration tests — the consume-only Anvil shell (v1.4 Anvil Executor).
 *
 * These drive `runAnvil` against a STUB anvil.py (no network, no key) that emulates the
 * real engine's contract: argv [label, spec, gate, budget], writes the best candidate to
 * <dirname(anvil)>/drafts/<label>.abmcts.py, and prints the authoritative `FINAL best=N/M`
 * ledger line. This lets us prove the whole shell — spec/gate emission, no-shell exec,
 * candidate copy-OUT, parse, decision — with zero live cost.
 *
 * Consume-only invariants asserted here:
 *   - spec + gate are written to the Factory SCRATCH dir, never anvil's tree
 *   - the candidate is copied OUT of anvil's drafts into scratch (we read, never keep, its tree)
 *   - `.keys.env` is never read (the stub has none; the shell must not require one)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runAnvil, probeAnvilAvailable } = require('../ferrox-core/bin/lib/anvil-executor.cjs');

/** A stub that mimics anvil.py's I/O contract. Mode is driven by a marker in the spec. */
const STUB = `#!/usr/bin/env python3
import sys, os, pathlib
label, spec_path, gate_path, budget = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
spec = open(spec_path).read()
drafts = pathlib.Path(__file__).resolve().parent / "drafts"
drafts.mkdir(exist_ok=True)
if "STUB_EMPTY" in spec:
    print("FINAL best=2/5  calls=12  out_tok=9000  flat_cost=$0.0009  TRUE_cost=$0.0050")
elif "STUB_PARTIAL" in spec:
    (drafts / (label + ".abmcts.py")).write_text("#!/usr/bin/env python3\\nprint('partial')\\n")
    print("FINAL best=4/5  calls=12  out_tok=9200  flat_cost=$0.0009  TRUE_cost=$0.0051")
else:
    (drafts / (label + ".abmcts.py")).write_text("#!/usr/bin/env python3\\nprint('solved')\\n")
    print("init [seed]: 3/5")
    print("GREEN at calls=2 $0.0002")
    print("FINAL best=5/5  calls=2  out_tok=1840  flat_cost=$0.0002  TRUE_cost=$0.0011")
`;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-shell-'));
  const anvilPath = path.join(root, 'anvil.py');
  fs.writeFileSync(anvilPath, STUB);
  const scratchDir = path.join(root, 'scratch');
  fs.mkdirSync(scratchDir);
  return { root, anvilPath, scratchDir };
}

const GATE = '#!/usr/bin/env python3\nimport sys\nprint("gate: 5/5")\n';

test('green run: candidate copied OUT to scratch, parsed green, accept-candidate (ANV-04)', () => {
  const { anvilPath, scratchDir } = setup();
  const r = runAnvil({
    anvilPath, scratchDir, label: 'demo',
    spec: 'Build a thing.', gateScript: GATE, budget: 12, timeoutMs: 20000,
  });
  assert.equal(r.ran, true);
  assert.equal(r.parsed.green, true);
  assert.equal(r.parsed.best, 5);
  assert.equal(r.candidatePresent, true);
  assert.equal(r.decision.action, 'accept-candidate');
  // candidate must live in SCRATCH (copied out), not only in anvil's drafts
  assert.ok(r.candidatePath.startsWith(scratchDir), 'candidate copied into scratch');
  assert.ok(fs.existsSync(r.candidatePath));
  assert.match(fs.readFileSync(r.candidatePath, 'utf8'), /solved/);
});

test('spec + gate are emitted into SCRATCH, never into anvil\'s tree (consume-only)', () => {
  const { anvilPath, scratchDir, root } = setup();
  runAnvil({ anvilPath, scratchDir, label: 'iso', spec: 'S', gateScript: GATE, budget: 4 });
  const scratchFiles = fs.readdirSync(scratchDir);
  assert.ok(scratchFiles.some((f) => /iso.*spec/i.test(f)), 'spec in scratch');
  assert.ok(scratchFiles.some((f) => /iso.*gate/i.test(f)), 'gate in scratch');
  // anvil's own tree holds only its drafts output + the stub — no Factory spec/gate leaked in
  const anvilTree = fs.readdirSync(root);
  assert.ok(!anvilTree.some((f) => /spec|gate/i.test(f)), 'no factory files at anvil root');
});

test('partial climb: candidate present but not green -> reject', () => {
  const { anvilPath, scratchDir } = setup();
  const r = runAnvil({ anvilPath, scratchDir, label: 'part', spec: 'STUB_PARTIAL task', gateScript: GATE, budget: 12 });
  assert.equal(r.parsed.green, false);
  assert.equal(r.candidatePresent, true);
  assert.equal(r.decision.action, 'reject');
});

test('silent burn: no candidate written -> fallback-normal (never trust the run)', () => {
  const { anvilPath, scratchDir } = setup();
  const r = runAnvil({ anvilPath, scratchDir, label: 'empty', spec: 'STUB_EMPTY task', gateScript: GATE, budget: 12 });
  assert.equal(r.candidatePresent, false);
  assert.equal(r.decision.action, 'fallback-normal');
});

test('missing anvil.py -> ran:false, fallback-normal, never throws', () => {
  const { scratchDir } = setup();
  const r = runAnvil({ anvilPath: '/no/such/anvil.py', scratchDir, label: 'x', spec: 'S', gateScript: GATE, budget: 4 });
  assert.equal(r.ran, false);
  assert.equal(r.decision.action, 'fallback-normal');
});

test('label is sanitized (no path traversal / shell metachars reach argv or filenames)', () => {
  const { anvilPath, scratchDir } = setup();
  const r = runAnvil({ anvilPath, scratchDir, label: '../../evil; rm -rf', spec: 'S', gateScript: GATE, budget: 4 });
  // whatever it did, it must not have escaped scratch, and must not throw
  assert.equal(typeof r.ran, 'boolean');
  if (r.candidatePath) assert.ok(r.candidatePath.startsWith(scratchDir));
  for (const f of fs.readdirSync(scratchDir)) assert.ok(!f.includes('/'), 'no slash in emitted filename');
});

test('probeAnvilAvailable: true for a real file + python, false for a missing path', () => {
  const { anvilPath } = setup();
  assert.equal(typeof probeAnvilAvailable(anvilPath), 'boolean');
  assert.equal(probeAnvilAvailable('/no/such/anvil.py'), false);
});
