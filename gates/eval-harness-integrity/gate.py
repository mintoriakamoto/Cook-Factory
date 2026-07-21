#!/usr/bin/env python3
"""eval-harness-integrity gate (MILESTONE v1.9 Wave 2, card gate_id eval-harness-integrity).

Scores an eval-harness deliverable (task set + scorer config + exemplar corpus, the mini
harness JSON contract) by RELATION to a calibration stub set the gate constructs itself:

  gold stub    the harness's own answer key
  random stub  deterministic pseudo-random option picks, sha256(task_id) seeded
  mutant stub  the harness's declared planted-mutant answer set

A harness is only trusted when it separates the stubs in the declared order at the
declared deltas. The gate never inspects prose quality; it measures discrimination.

Checks (8, ids stable, spec-clause order; categories per the card):
  EHI-01 execution  harness config loads and the scorer executes end to end on the gold stub
  EHI-02 relation   gold stub aggregate >= 0.98 of max
  EHI-03 relation   random stub aggregate within declared chance_level +/- 0.05
  EHI-04 relation   planted mutant drops >= max(declared_mutant_delta, 0.15 floor) vs gold
  EHI-05 grounding  no test item leaks from exemplars (word 3-gram containment > 0.8)
  EHI-06 structure  every task declares a compiling answer schema; <= 20 percent vacuous
  EHI-07 security   no scorer bypass channel (always_pass, skip/flaky lists, score floors)
  EHI-08 relation   strict stub ordering, gold > mutant > random, non-overlapping
                    +/- 0.05 intervals

Output contract v2: `FAIL <ID> <category>` per failed check, then `gate: N/8` (last
summary line wins per parseGateOutput). Runtime: python3 stdlib only, no third-party
imports, so the gate runs hermetically anywhere the suite runs.

Bypass channels are SIMULATED, not ignored: when a harness declares always_pass, skip
lists, or score floors, the gate scores the stubs the way that scorer actually would,
so the calibration checks surface the damage the bypass does in addition to the EHI-07
scan flagging the channel itself.
"""

import hashlib
import json
import re
import sys

EPS = 1e-9
GOLD_CEILING = 0.98
CHANCE_BAND = 0.05
DELTA_FLOOR = 0.15
LEAK_THRESHOLD = 0.8
NGRAM = 3
VACUOUS_MAX_FRACTION = 0.20
INTERVAL_HALF_WIDTH = 0.05

CHECKS = [
    ("EHI-01", "execution"),
    ("EHI-02", "relation"),
    ("EHI-03", "relation"),
    ("EHI-04", "relation"),
    ("EHI-05", "grounding"),
    ("EHI-06", "structure"),
    ("EHI-07", "security"),
    ("EHI-08", "relation"),
]

SCORER_TYPES = ("exact", "schema")
SCHEMA_TYPES = ("string", "number", "integer", "boolean", "object", "array")
SCHEMA_CONSTRAINT_KEYS = ("enum", "pattern", "minLength", "maxLength", "format", "const")
BYPASS_LIST_KEYS = ("skip_items", "known_flaky")


def pick_index(task_id, option_count):
    """Deterministic random-stub pick, byte-identical to pickIndex() in harness-lib.cjs."""
    digest = hashlib.sha256(task_id.encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % option_count


def schema_compiles(schema):
    if not isinstance(schema, dict):
        return False
    if not isinstance(schema.get("type"), str) or schema["type"] not in SCHEMA_TYPES:
        return False
    enum = schema.get("enum")
    if enum is not None and (not isinstance(enum, list) or len(enum) == 0):
        return False
    pattern = schema.get("pattern")
    if pattern is not None:
        if not isinstance(pattern, str):
            return False
        try:
            re.compile(pattern)
        except re.error:
            return False
    return True


def schema_is_vacuous(schema):
    """A bare type:string schema constrains nothing: any text validates."""
    if not isinstance(schema, dict) or schema.get("type") != "string":
        return False
    return not any(key in schema for key in SCHEMA_CONSTRAINT_KEYS)


def conforms(answer, schema):
    if not schema_compiles(schema):
        return False
    if schema["type"] != "string" or not isinstance(answer, str):
        return False
    enum = schema.get("enum")
    if isinstance(enum, list) and answer not in enum:
        return False
    pattern = schema.get("pattern")
    if isinstance(pattern, str) and re.search(pattern, answer) is None:
        return False
    min_length = schema.get("minLength")
    if isinstance(min_length, int) and len(answer) < min_length:
        return False
    max_length = schema.get("maxLength")
    if isinstance(max_length, int) and len(answer) > max_length:
        return False
    const = schema.get("const")
    if const is not None and answer != const:
        return False
    return True


def bypass_ids(scorer):
    ids = set()
    for key in BYPASS_LIST_KEYS:
        value = scorer.get(key)
        if isinstance(value, list):
            ids.update(item for item in value if isinstance(item, str))
    return ids


def score_stub(tasks, answers, scorer):
    """Aggregate score for an answer map, honoring the harness's declared scorer
    semantics INCLUDING its bypass channels (see module docstring)."""
    if len(tasks) == 0:
        raise ValueError("no tasks")
    skipped = bypass_ids(scorer)
    always_pass = bool(scorer.get("always_pass"))
    total = 0.0
    for task in tasks:
        answer = answers[task["id"]]
        if always_pass or task["id"] in skipped:
            total += 1.0
        elif scorer["type"] == "schema":
            total += 1.0 if conforms(answer, task.get("schema")) else 0.0
        else:
            total += 1.0 if answer == task["answer"] else 0.0
    aggregate = total / len(tasks)
    floor = scorer.get("score_floor")
    if isinstance(floor, (int, float)) and not isinstance(floor, bool):
        aggregate = max(aggregate, float(floor))
    return aggregate


def word_ngrams(text):
    tokens = re.findall(r"[a-z0-9]+", text.lower())
    if len(tokens) < NGRAM:
        return {tuple(tokens)} if tokens else set()
    return {tuple(tokens[i : i + NGRAM]) for i in range(len(tokens) - NGRAM + 1)}


def max_containment(prompt, exemplars):
    """Highest fraction of the prompt's word 3-grams contained in any single exemplar."""
    prompt_grams = word_ngrams(prompt)
    if not prompt_grams:
        return 0.0
    best = 0.0
    for exemplar in exemplars:
        exemplar_grams = word_ngrams(exemplar)
        best = max(best, len(prompt_grams & exemplar_grams) / len(prompt_grams))
    return best


def load_harness(path):
    """Structural load. Raises on anything the scorer cannot execute against."""
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("harness is not an object")
    tasks = data.get("tasks")
    if not isinstance(tasks, list) or len(tasks) == 0:
        raise ValueError("tasks missing or empty")
    seen_ids = set()
    for task in tasks:
        if not isinstance(task, dict):
            raise ValueError("task is not an object")
        task_id = task.get("id")
        if not isinstance(task_id, str) or task_id == "" or task_id in seen_ids:
            raise ValueError("task id missing or duplicated")
        seen_ids.add(task_id)
        if not isinstance(task.get("prompt"), str) or task["prompt"] == "":
            raise ValueError("task prompt missing")
        options = task.get("options")
        if not isinstance(options, list) or len(options) < 2:
            raise ValueError("task options missing")
        if any(not isinstance(option, str) for option in options):
            raise ValueError("task option is not a string")
        if len(set(options)) != len(options):
            raise ValueError("task options are not distinct")
        if not isinstance(task.get("answer"), str):
            raise ValueError("task answer missing")
    scorer = data.get("scorer")
    if not isinstance(scorer, dict) or scorer.get("type") not in SCORER_TYPES:
        raise ValueError("scorer missing or unknown type")
    exemplars = data.get("exemplars")
    if not isinstance(exemplars, list) or any(not isinstance(e, str) for e in exemplars):
        raise ValueError("exemplars missing")
    mutant_answers = data.get("mutant_answers")
    if not isinstance(mutant_answers, dict):
        raise ValueError("mutant_answers missing")
    return data


def build_stubs(data):
    """The calibration triple: gold and random are gate-constructed, mutant is the
    harness's own declared planted answer set (missing entries fall back to gold)."""
    gold = {}
    random_stub = {}
    mutant = {}
    for task in data["tasks"]:
        task_id = task["id"]
        gold[task_id] = task["answer"]
        random_stub[task_id] = task["options"][pick_index(task_id, len(task["options"]))]
        declared = data["mutant_answers"].get(task_id)
        mutant[task_id] = declared if isinstance(declared, str) else task["answer"]
    return gold, random_stub, mutant


def run_checks(path):
    """Returns the set of failed check ids. Fails closed: an unloadable or
    non-executable harness fails every check."""
    failed = set()
    try:
        data = load_harness(path)
        gold, random_stub, mutant = build_stubs(data)
        gold_score = score_stub(data["tasks"], gold, data["scorer"])
        random_score = score_stub(data["tasks"], random_stub, data["scorer"])
        mutant_score = score_stub(data["tasks"], mutant, data["scorer"])
    except Exception:
        return {check_id for check_id, _ in CHECKS}

    # EHI-02: gold stub at ceiling.
    if gold_score < GOLD_CEILING - EPS:
        failed.add("EHI-02")

    # EHI-03: random stub inside the declared chance band.
    chance = data.get("chance_level")
    if (
        not isinstance(chance, (int, float))
        or isinstance(chance, bool)
        or not 0.0 < float(chance) < 1.0
        or abs(random_score - float(chance)) > CHANCE_BAND + EPS
    ):
        failed.add("EHI-03")

    # EHI-04: planted mutant drops by at least max(declared delta, floor). The floor
    # closes the declared-a-trivial-delta gamed mode on the card.
    declared_delta = data.get("declared_mutant_delta")
    if (
        not isinstance(declared_delta, (int, float))
        or isinstance(declared_delta, bool)
        or float(declared_delta) <= 0.0
        or (gold_score - mutant_score) + EPS < max(float(declared_delta), DELTA_FLOOR)
    ):
        failed.add("EHI-04")

    # EHI-05: exemplar leakage scan.
    for task in data["tasks"]:
        if max_containment(task["prompt"], data["exemplars"]) > LEAK_THRESHOLD + EPS:
            failed.add("EHI-05")
            break

    # EHI-06: schemas compile and the vacuous fraction stays under the ban threshold.
    vacuous = 0
    for task in data["tasks"]:
        schema = task.get("schema")
        if not schema_compiles(schema):
            failed.add("EHI-06")
            break
        if schema_is_vacuous(schema):
            vacuous += 1
    else:
        if vacuous / len(data["tasks"]) > VACUOUS_MAX_FRACTION + EPS:
            failed.add("EHI-06")

    # EHI-07: bypass-channel scan on the scorer config.
    scorer = data["scorer"]
    floor = scorer.get("score_floor")
    has_floor = isinstance(floor, (int, float)) and not isinstance(floor, bool) and float(floor) > 0.0
    if bool(scorer.get("always_pass")) or len(bypass_ids(scorer)) > 0 or has_floor:
        failed.add("EHI-07")

    # EHI-08: strict stub ordering with non-overlapping +/- 0.05 intervals.
    if not (
        gold_score - INTERVAL_HALF_WIDTH > mutant_score + INTERVAL_HALF_WIDTH + EPS
        and mutant_score - INTERVAL_HALF_WIDTH > random_score + INTERVAL_HALF_WIDTH + EPS
    ):
        failed.add("EHI-08")

    # EHI-01: the end-to-end execution predicate. Reaching this line means load and
    # gold-stub scoring completed; the except path above is the failure mode.
    return failed


def main(argv):
    if len(argv) < 2:
        failed = {check_id for check_id, _ in CHECKS}
    else:
        failed = run_checks(argv[1])
    for check_id, category in CHECKS:
        if check_id in failed:
            print(f"FAIL {check_id} {category}")
    passed = len(CHECKS) - len(failed)
    print(f"gate: {passed}/{len(CHECKS)}")
    return 0 if len(failed) == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
