---
card: 1
gate_id: test-generation
domain: test-generation
tier: 1
relational_target:
  artifact: the Python module under test, bundled with the suite by the orchestrator
  relation: mutation-kill rate on per-run sampled AST mutants of the target, plus executed-line coverage delta vs the declared baseline
disclosure_default: opaque
checks:
  - id: TG-01
    category: relation
    desc: mutation kill rate meets the declared threshold
    measures: "kill fraction over MUTANT_SAMPLE_K per-run sampled non-trivial AST mutants >= declared kill_threshold"
  - id: TG-02
    category: relation
    desc: coverage delta vs the declared baseline
    measures: "executed-line coverage percent minus coverage_baseline >= coverage_min_delta, via coverage.py with stdlib trace fallback on a shared AST-derived denominator"
  - id: TG-03
    category: structure
    desc: zero assert-free test functions
    measures: "AST scan, every test function carries at least 1 non-literal-constant assertion"
  - id: TG-04
    category: value
    desc: zero self-comparing asserts
    measures: "AST scan for x == x compare shapes and assertEqual-family calls with 2 identical argument expressions"
  - id: TG-05
    category: execution
    desc: suite passes against the unmutated target
    measures: "subprocess unittest run exits 0, zero collected tests fails via unittest exit 5"
  - id: TG-06
    category: security
    desc: suite never mutates or monkeypatches the target
    measures: "AST scan for target attribute assignment, setattr, mock.patch aimed at the target, and file-write channels, plus a before/after hash of the target source across the TG-05 run"
wrapped_tools:
  - name: python3
    version: 3.14.5
    license: PSF-2.0
    role: "gate runtime, mutation engine, unittest runner, stdlib only"
  - name: coverage
    version: 7.13.5
    license: Apache-2.0
    role: "executed-line measurement, optional, degrades to the stdlib trace module"
validation:
  reference: sealed:sha256:40d4bb2975a212ad2314c62144eb58e19235cca554853eeaea003acc1a37775e
  pool_min: 5
  pool_status: full
  mutants:
    - id: tg-m1
      class: fluent-but-wrong
      why_fluent: broad behavioural sweep that executes every branch of every function with realistic data and asserts only types and non-nullness, coverage reads as excellent while no behavioural mutant can ever trip it
      expected_drop: 1
      must_fail: [TG-01]
      fixture: sealed:sha256:368c2d955c8074b22f322d92b3963682a63fed40a93f754b788e1d6bc64dd2ee
    - id: tg-m2
      class: fluent-but-wrong
      why_fluent: correct expectations for empty and single-interval inputs, reads as clean contract testing while the merge loop, boundaries, and helper functions are never exercised so the kill rate collapses
      expected_drop: 2
      must_fail: [TG-01, TG-02]
      fixture: sealed:sha256:a67c2a2633f0dd007d051510414992ff43fdd636707aa6c0dab934cf0d49f73f
    - id: tg-m3
      class: fluent-but-wrong
      why_fluent: determinism and stability framing makes every assertEqual of an expression against the identical expression look rigorous, the suite can never disagree with the implementation mutated or not
      expected_drop: 2
      must_fail: [TG-01, TG-04]
      fixture: sealed:sha256:1c00672c9b72de2743adb96e341030af64c3906965d1c0a77957114072bbc811
    - id: tg-m4
      class: fluent-but-wrong
      why_fluent: golden-value regression framing with expectations captured from the implementation at runtime, passes today by construction and keeps passing under mutants because the oracle mutates together with the code under test
      expected_drop: 1
      must_fail: [TG-01]
      fixture: sealed:sha256:3e809798cc25c67d75afba19dbdb0beea08b81db6038c2140aa309a21ff11c80
    - id: tg-m5
      class: fluent-but-wrong
      why_fluent: exhaustive execution sweep that lights up every line of the target through nested loops, coverage reads as total while every assertion is a literal constant
      expected_drop: 2
      must_fail: [TG-01, TG-03]
      fixture: sealed:sha256:b407b4ea931fe9ab0839505fdbee4faae4a66743f19ba3c6b60d14a00dd934e4
  rotation_k: 2
  last_validated: 2026-07-21
gamed_modes:
  - mode: computed-oracle expectations derived from the implementation at runtime
    status: sealed
    note: tg-m4 encodes it, the kill relation exposes it because the oracle mutates with the target
  - mode: coverage gaming through no-op execution sweeps
    status: sealed
    note: tg-m5 encodes it, TG-01 scores discrimination not execution and TG-03 rejects constant-only asserts
  - mode: memorizing the sampled mutant set
    status: mitigated
    note: per-run sample seeded sha256(runId colon gateId) over the pruned pool, exactly the Wave 1 rotation algorithm
  - mode: shipping a weakened target or thresholds inside the bundle
    status: mitigated
    note: the bundle is orchestrator-constructed, the suite file is the only builder-authored member
  - mode: a failing suite trivially killing every mutant
    status: mitigated
    note: TG-01 refuses to measure kills unless TG-05 is green on the pristine target first
  - mode: judging test readability or naming quality
    status: crucible
    note: prose-adjacent judgment slice, gate-hostile per gap report section 3, this gate measures discrimination only
escape_hatch_bans:
  - ban: mutating or monkeypatching the target module from inside the suite (attribute assignment, setattr, mock.patch, file rewrites)
    check: TG-06
---

## Intent

The flagship RELATIONAL gate (milestone locked decision 3): a test suite is scored by its
relationship to the code under test, never by inspection of the suite itself. "Tests pass"
is worthless as a quality signal because every fluent-but-wrong suite in the pool passes;
this gate measures whether the suite would NOTICE the target being wrong. Tier 1: every
check is executable and deterministic per (runId, bundle).

The deliverable under test is the suite source inside an orchestrator-constructed bundle
(target module, smoke probes, and declared thresholds ride on the trusted side). Mutation
kill is measured on a pruned pool: mutants that crash the orchestrator smoke probes are
discarded as trivial, because mere execution kills them and they carry zero discrimination
signal. Every surviving pool member requires a real assertion to catch, which is what makes
the reference-vs-mutant separation total: the reference suite kills 10 of 10 pool mutants
while all 5 fluent mutant suites kill 3 or fewer, so the verdict holds for every possible
rotation sample, not just a lucky seed.

## Gamed-mode rationale

The 2 sealed modes are the signature failure shapes of generated test suites: oracles
derived from the implementation (tg-m4) and coverage theater (tg-m5). Both survive human
skim review and both are structurally invisible to any "tests pass plus coverage" gate;
only the kill relation exposes them. The mitigated modes are boundary conditions of the
measurement itself: rotation closes mutant memorization, orchestrator bundle construction
closes threshold tampering, and the TG-05 precondition closes the failing-suite shortcut.
Readability judgment is routed to the crucible per the gate-hostile list.

## Change log

- 2026-07-21 authored in Wave 3 with the sealed-store fixture flow, 5-member fluent pool, and v2 FAIL surface from day 1.
