---
card: 1
gate_id: skill-instruction-files
domain: agent-ops
tier: 1
relational_target:
  artifact: the workspace tree and tool/skill manifest the file instructs over
  relation: every referenced path, tool, and skill resolves against it
disclosure_default: opaque
checks:
  - { id: SK-01, category: grounding, desc: no dead references, measures: referenced relative paths exist under --workspace; frontmatter tools and backticked /slash skills appear in the --manifest }
  - { id: SK-02, category: value, desc: token budget respected, measures: ceil(chars/3.6) <= declared budget (flag, then frontmatter budget_tokens, then 4000); the 3.6 chars-per-token estimate tracks cl100k-family tokenizers on English markdown within about 10 percent }
  - { id: SK-03, category: execution, desc: fenced bash examples work, measures: bash -n on every bash/sh block; blocks marked runnable must exit 0 in a sandbox tmpdir with sandboxed cwd and HOME }
  - { id: SK-04, category: structure, desc: frontmatter schema valid, measures: frontmatter present, name non-empty, description length >= 40 chars }
  - { id: SK-05, category: relation, desc: no contradictory directives, measures: declared pairs of mutually exclusive regex patterns; both sides matching the document fails }
  - { id: SK-06, category: value, desc: editorial floor holds, measures: no em dash anywhere; digits not spelled-out numbers in front of countable nouns }
wrapped_tools:
  - { name: node, version: 20.20.2, license: MIT, role: gate runtime, stdlib only }
  - { name: bash, version: 3.2.57, license: GPL-2.0-only, role: example syntax check and sandbox execution, invoked as a host binary and never shipped }
validation:
  reference: sealed:sha256:<assigned by the generator seal step on the operator machine>
  pool_min: 5
  pool_status: full
  mutants:
    - id: sk-m1
      class: fluent-but-wrong
      why_fluent: references scripts/run-checks.cjs, a plausible plural of the real script name; every other line is identical to a passing file
      expected_drop: 1
      must_fail: [SK-01]
      fixture: sealed:sha256:<assigned at seal>
    - id: sk-m2
      class: fluent-but-wrong
      why_fluent: sits 40 percent over the token budget purely through polite reviewer-courtesy paragraphs; each one reads professional in isolation
      expected_drop: 1
      must_fail: [SK-02]
      fixture: sealed:sha256:<assigned at seal>
    - id: sk-m3
      class: fluent-but-wrong
      why_fluent: a runnable bash example calls ls with a plausible flag that does not exist; bash -n passes, only execution exposes it
      expected_drop: 1
      must_fail: [SK-03]
      fixture: sealed:sha256:<assigned at seal>
    - id: sk-m4
      class: fluent-but-wrong
      why_fluent: forbids auto-commit near the top and mandates auto-commit 200+ lines later; each directive reads sane where it stands
      expected_drop: 1
      must_fail: [SK-05]
      fixture: sealed:sha256:<assigned at seal>
    - id: sk-m5
      class: fluent-but-wrong
      why_fluent: frontmatter is structurally complete so shape scanners pass; the description value is an empty string
      expected_drop: 1
      must_fail: [SK-04]
      fixture: sealed:sha256:<assigned at seal>
  rotation_k: 2
  last_validated: null
gamed_modes:
  - mode: reference-sparse file that mentions nothing resolvable so SK-01 has nothing to check
    status: crucible
    note: the dead-ref scan is permissive on sparse files by design; reference completeness is a judgment slice owned by spec review
  - mode: marking every bash example non-runnable so SK-03 only syntax-checks
    status: mitigated
    note: the task spec for deliverables gated here requires at least 1 runnable example; runnable blocks are hard-failed on nonzero exit
  - mode: lexical satisfaction of named FAIL strings (pre-v2 surface)
    status: sealed
    note: closed by opaque ids plus the rotating fluent mutant pool
escape_hatch_bans: []
---

## Intent

Gate the highest-frequency operator artifact class (SKILL.md, CLAUDE.md, AGENTS.md, system
prompts). These files are edited weekly and rot silently: paths get renamed under them, budgets
creep, examples stop running, and directives added months apart contradict each other. Tier 1:
the gate resolves references against the live workspace and actually executes the examples.

Invocation the orchestrator runs (artifact path appended by gate-runner):

`node gates/skill-instruction-files/gate.cjs --workspace <dir> --manifest <manifest.json> --budget 2600 <artifact>`

Fixture content is never committed. `generators.cjs` in this directory is the committed
authoring surface: the orchestrator generates reference + pool with a per-seal nonce, seals
them, and fills the `sealed:sha256:` references above on the operator machine.

## Gamed-mode rationale

A file that references nothing dodges SK-01 honestly; that is a completeness judgment, not a
mechanical check, so it routes to spec review per the gate-hostile list. Everything the pool
encodes (renamed paths, polite bloat, dead flags, split contradictions, hollow frontmatter) is
mechanically caught and rotates from the sealed store.

## Change log

- 2026-07-21 authored in Wave 4; 6-check inventory, 5-mutant fluent pool via generators.
