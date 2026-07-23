---
card: 1
gate_id: citation-sources
domain: research
tier: 4
gate_script_hash: 5c8acc7cf0b85bfade6eaf6ee8f0595d1a80205c0c3f443b95bf53d649a91871
relational_target:
  artifact: the SOURCES.md ledger
  relation: every claim marker and quoted span in the report resolves against and matches the ledger
disclosure_default: opaque
checks:
  - { id: CS-01, category: structure, desc: ledger parses with schema and internal integrity intact, measures: canon-facts sources validation (URL syntax excluded, owned by a later check) plus archived and paywalled entries carry excerpt and content_hash, and every content_hash equals the sha256 of the stored excerpt under the locked normalization }
  - { id: CS-02, category: grounding, desc: every claim marker resolves honestly, measures: each marker id exists in the ledger; a marker citing a retracted entry must carry the retracted annotation, and the annotation is illegal on an entry the ledger does not declare retracted }
  - { id: CS-03, category: grounding, desc: quoted spans are verbatim against their cited excerpts, measures: normalized quote matches the normalized excerpt under the locked alteration grammar; a plain mismatch fails; an internal ellipsis whose elided ledger-side span contains a negation token fails; a construct beyond the grammar abstains as INDET }
  - { id: CS-04, category: value, desc: ledger url fields are syntactically valid, measures: WHATWG URL parse via node stdlib on every declared url; syntax only, the gate never fetches }
  - { id: CS-05, category: grounding, desc: no unresolved declared claims, measures: in a report whose frontmatter declares claims, every top-level list item carries at least 1 marker after comment and fence stripping }
  - { id: CS-06, category: value, desc: dead ledger entries surface as advisories, measures: entries never cited by the report emit WARN lines only; this check never fails by contract }
wrapped_tools:
  - { name: node, version: 20.20.2, license: MIT, role: gate runtime, stdlib only }
  - { name: js-yaml, version: 4.2.0, license: MIT, role: ledger YAML parse, vendored at ferrox-core/bin/vendor and loaded by relative require, never a package require }
validation:
  reference: sealed:sha256:6db8e0bf361d6ef0b3acadbd670148ccdb8b37c1e1493b3cc11877c5a104066b
  pool_min: 5
  pool_status: full
  mutants:
    - id: cs-m1
      class: fluent-but-wrong
      why_fluent: the quote reads faithful and keeps the source's number and framing; it is a paraphrase, not the verbatim excerpt, and only character-level comparison notices
      expected_drop: 1
      must_fail: [CS-03]
      fixture: sealed:sha256:7be38b33805de78c305a4a7add8493edc7dd5b9bbcc4e8d8fe4708b7308f6db9
    - id: cs-m2
      class: fluent-but-wrong
      why_fluent: 2 markers are swapped between quotes; every id resolves so referential integrity passes, and each citation looks fully sourced while neither quote matches its cited entry
      expected_drop: 1
      must_fail: [CS-03]
      fixture: sealed:sha256:3c69c10b4b90246472435e61dcc6e976e5c5f6bcbe5374ccbef1c3346696db80
    - id: cs-m3
      class: fluent-but-wrong
      why_fluent: a retracted ledger entry is cited straight-faced as live support; the quote is verbatim and the id resolves, so the citation reads impeccable at a skim
      expected_drop: 1
      must_fail: [CS-02]
      fixture: sealed:sha256:baa8898af9d8d78150d4f427fed12208440d1b86842ba3dea11a9a87302ab1b6
    - id: cs-m4
      class: fluent-but-wrong
      why_fluent: the ledger excerpt was silently edited after ingest; the entry still reads clean and current, and only the content hash remembers what was actually captured
      expected_drop: 1
      must_fail: [CS-01]
      fixture: sealed:sha256:fce0a20d7fde6c7915f1cdccd12ca81262283a172cb51a613bda1b3edf708333
    - id: cs-m5
      class: fluent-but-wrong
      why_fluent: a legally formatted ellipsis elides the words that negate the finding; the trimmed quote reads like a faithful shortening while flipping the source's claim
      expected_drop: 1
      must_fail: [CS-03]
      fixture: sealed:sha256:d7f6cacbdffbdddfa5d55c80311c965cedff4a14dbc5601d0aa360919639ba00
  rotation_k: 2
  last_validated: 2026-07-23
gamed_modes:
  - mode: fluent citation rot, quotes and citations tuned to read faithful at a skim (paraphrase, transposed ids, silent retraction, drifted excerpt, negation-hiding trim)
    status: sealed
    note: exactly the pool; opaque ids plus the rotating fluent mutant set keep the surface unmemorizable
  - mode: prose asserts claims outside the declared markers, false content with no marker at all
    status: crucible
    note: the research judgment eye (ferrox-method-reviewer, Wave 4) plus the receipt scope disclaimer (amendment A4) own it; the gate scores only the declared claim surface and says so on every run
  - mode: resolving-but-unsupporting citation, a quoteless marker cites a real entry whose excerpt does not actually support the sentence
    status: crucible
    note: relevance is judgment; the gate proves resolution and verbatim fidelity, never support strength
escape_hatch_bans:
  - ban: claim markers inside HTML comments or fenced code blocks do not count as markers, so hiding a claim's only marker there leaves the claim unresolved
    check: CS-05
  - ban: a retracted annotation on an entry the ledger does not declare retracted (laundering the acknowledgment channel)
    check: CS-02
---

## Intent

Fill the research registry lane (tier 4 gate-first, empty until this pack) with a
deterministic grounding floor: a research or nonfiction report is scored by its RELATION
to the SOURCES.md ledger the project's canon store declares. The gate proves that every
citation resolves, that every quoted span is verbatim against the excerpt captured at
ingest, and that the ledger itself has not drifted since capture. It never fetches
anything: per amendment A6 there is NO network in the sealed checks (SK-01 precedent,
tokens containing :// are never dereferenced); URL checks are WHATWG syntax parses and
live link checking stays a workflow-layer advisory. Support strength and argument quality
are judgment and route to the eyes, never here.

### Input contract (complete, deterministic)

**The ledger.** A canon store document carrying exactly 1 fenced block opened by a line
reading 3 backticks plus `yaml canon-facts` with `schema: canon-facts/v1` and
`store: sources` (the CANON-01 contract, parsed and validated by
`ferrox-core/bin/lib/canon-facts.cjs`). Each entry: kebab-case unique `id`, `access` 1 of
live, archived, offline, paywalled, ISO `access_date`, non-empty `excerpt` (the trusted
verbatim anchor captured at ingest), optional `url`, optional `content_hash`
(`sha256:` plus 6 to 64 hex), optional `retracted: true`. This gate adds 2 integrity
rules on top of the schema: entries with access archived or paywalled MUST carry
`content_hash`, and every declared `content_hash` hex must equal the leading hex of the
sha256 of the entry's excerpt normalized under the locked table below, so a silently
edited excerpt fails CS-01.

**The report.** A markdown document. Claim markers use the span syntax `[S:<source-id>]`
where source-id is the cited ledger id, or the acknowledgment form
`[S:<source-id> retracted]` (exactly 1 space). Before any scanning, the gate strips the
report frontmatter, all fenced code blocks, and all HTML comments: a marker inside any of
those does not exist.

**Quote binding.** A quote is a double-quoted span, straight or curly, whose closing
quote character immediately precedes its marker in the same paragraph (paragraphs are
blank-line separated blocks; only whitespace may sit between the closing quote and the
opening bracket of the marker). The opening quote is the nearest preceding same-family
quote character in the paragraph; quoted spans must not contain unescaped double-quote
characters (use single quotes inside). A marker with no such span is a plain citation:
CS-02 still applies, CS-03 does not.

**Retraction rule (CS-02).** A marker citing an entry with `retracted: true` must use the
acknowledgment form. The bare form on a retracted entry fails; the acknowledgment form on
an entry the ledger does not declare retracted also fails (the ban above).

**Declared-claims reports (CS-05).** A report whose frontmatter carries
`claims: declared` promises that its claim surface is enumerable: every TOP-LEVEL markdown
list item (a line starting with a list bullet at indent 0 to 3, plus its indented
continuation lines up to the next blank line, top-level item, or heading) is a declared
claim and must contain at least 1 marker. Without the flag CS-05 passes vacuously and the
report's claim discipline is the eyes' business.

**Quote verbatim rule (CS-03), locked normalization (amendment A6).** Both the quote and
the excerpt are normalized before comparison: Unicode NFC; curly double and single quotes
to straight; em dash, en dash, and horizontal bar to hyphen; the ellipsis character to 3
dots; all whitespace runs collapsed to 1 space; trimmed. Comparison is case-sensitive.
The legal alteration grammar is ellipsis plus at most 1 bracketed substitution:

- No alteration: the normalized quote must appear contiguously in the normalized excerpt.
- Ellipsis (`...`): the quote splits into ordered segments, each of which must appear in
  the excerpt in order without overlap. Leading and trailing ellipses mark truncation and
  are not inspected. An INTERNAL ellipsis has its elided ledger-side span scanned: if the
  span contains a negation token (not, never, no, cannot, or an n't contraction) the
  check FAILS. That is the ellipsis-hiding-a-negation rule.
- Bracketed substitution: at most 1 `[...]` segment per quote, standing for 0 to 3
  consecutive source words at that position (0 covers pure insertions such as `[sic]`).
- Beyond the grammar (2 or more bracketed segments, unbalanced brackets, or a quote its
  own alterations leave empty): the gate emits `INDET CS-03 <reason-code>` and abstains
  on that quote. INDET NEVER fails and
  never moves the score (web-ui precedent); the judgment eyes consume the lines.
- Any other outcome is a plain mismatch and FAILS.

**Advisory semantics (CS-06).** Ledger entries never cited by the report each emit 1
`WARN CS-06 unused-source <id>` line. CS-06 never fails, no mutant may target it, and the
lines exist for the keeper and the eyes: a dead entry is hygiene debt, not a defect in
the report under test.

### Invocation

2-part mode (the workflow invocation; artifact path appended by gate-runner):

`node gates/citation-sources/gate.cjs --ledger <SOURCES.md path> <report.md>`

Packet mode (sealed fixtures and self-contained research packets): when `--ledger` is
absent, the report itself must embed the single `yaml canon-facts` sources block, which
is then the ledger. When both are present `--ledger` wins. The embedded block is a fence,
so it is invisible to claim scanning either way.

Output contract v2: 1 `FAIL <ID> <category>` line per failing check, INDET and WARN
lines as documented above (the gate-runner parser provably ignores both), then the
summary `gate: N/6`. Exit 0 only when all 6 checks pass. Fail closed: an unreadable
artifact or an internal crash scores 0/6; an unusable ledger fails CS-01 through CS-04
while CS-05 still scores the report side.

Fixture content is never committed. `fixtures/generators/generators.cjs` in this
directory is the committed authoring surface; `fixtures/generators/seal-fixtures.cjs` is
the operator script that generates reference plus pool with a per-seal nonce, seals them
into the sealed store, and prints the `sealed:sha256:` URIs that belong above.
`gate_script_hash` is recorded at seal time; any edit to `gate.cjs` changes it and voids
`last_validated` until a re-seal and re-validation on the operator machine.

## Gamed-mode rationale

The judgment slice routes out by design: whether a source actually supports the sentence
citing it, whether the claim surface is honest about what the prose asserts, whether the
sources themselves are any good. That is the research judgment eye's job plus the receipt
scope disclaimer, per amendments A4 and A7. What the pool encodes is the mechanical rot a
skimming reviewer reliably waves through: a paraphrase wearing quote marks, markers
swapped between real sources, a retraction cited as if live, an excerpt edited out from
under its own hash, and a legal-looking ellipsis that deletes a negation. The 5 mutant
seeds were enumerated in the v1.13 plan cross-audit (amendment A7), not in the original
prior-art research.

## Change log

- 2026-07-23 authored in v1.13 Wave 3: 6-check inventory, packet and 2-part invocation
  modes, locked A6 normalization and alteration grammar, 5-mutant fluent pool from the A7
  seeds, sealed and validated on the operator machine.
