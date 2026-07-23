---
name: canon-init
description: Create the declared canon store(s), LORE.md and/or SOURCES.md, with the machine canon-facts block the creative line gates against.
---

<purpose>
Create the declared canon store(s) at the project root: LORE.md (book and
writing) and/or SOURCES.md (research and nonfiction). Each store is human-owned prose
around exactly 1 fenced machine block opened with an info string of `yaml canon-facts`.

3 modes:
- **Interview** (default): recommendation-first interview, then write.
- **`--from-existing`**: scan a manuscript, notes, chapters, or bibliography; draft from
  what is already true, confirming only gaps.
- **`--from-brainstorm`**: seed entities, threads, world rules, and sources from the book
  or software BRAINSTORM.md (the v1.12 brainstorm artifact).
</purpose>

<canonical_spec>
Hard rule: every entry must be checkable by a reviewer without asking the author what they
meant. "A brooding city" is not canon; `status: dead` with `provenance: ch-vault-heist:44` is.
</canonical_spec>

<canonical_layout>
- LORE.md and SOURCES.md live at the project root. Both are legal in 1 project (nonfiction book).
- Chapters live at book/chapters/ch-<slug>.md. STABLE SLUGS, never sequence numbers:
  renumbering breaks provenance; slugs never move.
- The spine manifest at book/SPINE.md is the SINGLE ordering truth. Chapter files carry
  chapter_id, not position. Insertion or reorder is a manifest edit only. The assembler
  hard-errors on orphans: a chapter file with no spine row, a spine row with no file.
- Provenance keys are chapter_id:line, e.g. ch-vault-heist:44.

Spine manifest format (prose header, then 1 fenced block):

```yaml spine
schema: spine/v1
chapters:
  - id: ch-vault-heist
    title: The Vault Heist
    status: drafted               # planned | drafted | revised | final
```

List order = book order. This file is the only ordering truth.
</canonical_layout>

<declared_facts_schema>
The normative schema spec for the whole canon line.

LORE.md block skeleton (schema canon-facts/v1, store lore):

```yaml canon-facts
schema: canon-facts/v1
store: lore
entities:
  - id: mara-vale                 # unique kebab-case id
    type: character               # character | place | faction | system | prop
    name: Mara Vale               # canonical display name
    aliases: [Mara, the Cartographer]
    status: alive                 # alive | dead | departed | deprecated
    introduced: ch-vault-heist:12 # first-appearance provenance, canonical
    birthdate: 2841-03-04         # optional, declared calendar
    death_date: null              # optional; must be >= birthdate when both set
    facts:                        # typed key facts, each with provenance
      - key: eye_color
        value: grey
        provenance: ch-vault-heist:44
timeline:
  - date: 2863-06-01
    event: The vault heist begins
    provenance: ch-vault-heist:210
threads:
  - id: the-missing-map
    status: open                  # open | closed
    opened: ch-vault-heist
    closed: null
```

SOURCES.md block skeleton (store sources):

```yaml canon-facts
schema: canon-facts/v1
store: sources
sources:
  - id: doe-2024-grid             # unique kebab-case id
    title: Grid Storage Economics 2024
    author: J. Doe
    url: https://example.org/grid-2024   # optional; syntax checked only, never fetched
    access: archived              # live | archived | offline | paywalled
    content_hash: sha256:0f3a9c   # optional, archived-content hash
    access_date: 2026-07-23       # ISO date captured at ingest
    excerpt: "Storage costs fell 89 percent between 2010 and 2023."  # trusted verbatim anchor, required
```

Deterministic validation rules (src/canon-facts.cts, the Wave 3 gate substrate, implements
exactly these):
- Common: fenced block present exactly once; parses as YAML; `schema` is `canon-facts/v1`;
  `store` is `lore` or `sources` and matches the collections present.
- Lore: entity ids unique kebab-case; no alias equals another entity's canonical name or
  alias (collision); type and status enums as in the skeleton; `introduced` and every
  `provenance` match `^ch-[a-z0-9-]+:[1-9][0-9]*$`; death_date >= birthdate when both
  present; timeline dates parse (ISO-like `YYYY-MM-DD` or `YYYY`); thread ids unique;
  thread status enum; a closed thread has `closed` set, an open thread has `closed: null`.
- Sources: ids unique kebab-case; access enum as in the skeleton; access_date is ISO
  `YYYY-MM-DD`; excerpt is a non-empty string; url when present must be syntactically a
  URL (never fetched); content_hash when present matches `^sha256:[0-9a-f]{6,64}$`.
- Return shape: `{ ok, store, facts, errors }` where errors are `{ code, path, message }`.
  Validation never throws on bad input; it reports errors.
</declared_facts_schema>

<process>

## Step 1: Check for existing stores

```bash
test -f LORE.md && echo "LORE.md exists"
test -f SOURCES.md && echo "SOURCES.md exists"
```

If either store exists, never silently overwrite. Recommend first, then ask: targeted
update (recommended when the store is mostly right), full regeneration, or stop. Apply
the choice; a targeted update skips to Step 4.

## Step 2: Resolve domain and template

Read the stored domain: `ferrox-tools config-get domain --raw`. Map it:

| domain | template | store(s) written |
|---|---|---|
| writing / book | book | LORE.md |
| research / long-form nonfiction | research | SOURCES.md |
| nonfiction book | book + research | LORE.md AND SOURCES.md |
| null domain | ask 1 recommendation-first question, then `config-set domain` | per answer |

On a null domain, state your pick and the why before the alternatives,
then store it once: `ferrox-tools config-set domain <value>`.

## Step 3: Pick the mode

`--from-existing` goes to Step 3B; `--from-brainstorm` to Step 3C. Otherwise scan for signal:

```bash
ls book/chapters/*.md chapters/*.md manuscript/*.md notes/*.md 2>/dev/null | head -5
ls .planning/brainstorms/*/BRAINSTORM.md 2>/dev/null | head -3
```

Manuscript found: recommend `--from-existing`. Brainstorm found:
`--from-brainstorm`. Neither: interview (Step 3A). Confirm the pick.

## Step 3A: Recommendation-first interview

Ground in the README and premise notes. Every question leads with a verified
recommendation and the why; never a bare option list. 1 question per message, 5 questions
maximum:

1. **Premise and scope**: your read of the work and what the store must protect.
2. **Seed entities or sources**: the 3 to 6 already visible, typed per the skeleton.
3. **Timeline anchor**: calendar and anchoring events (book), or citation posture (research).
4. **Open threads**: thread list (book) or source coverage gaps (research).
5. **Canon boundary**: canon versus draft-only speculation.

## Step 3B: Draft from existing material (`--from-existing`)

Scan chapters, manuscript, notes, bibliography. Extract entities with aliases and first
appearances (chapter_id:line), timeline events, threads; for research, sources with title,
author, url, access, verbatim excerpt. Conflicts are marked (proposed) and resolved
recommendation-first. Confirm only gaps; never re-ask what the text answers.

## Step 3C: Seed from the brainstorm (`--from-brainstorm`)

Read the BRAINSTORM.md artifact. Mine its Decisions, world rules, entities, threads, and
cited sources. Brainstorm facts lack chapter provenance: only anchor-checkable facts enter
the block; the rest lands in a human-owned "Pending canon" section, promoted by the keeper
with real provenance once a chapter exists.

## Step 4: Write the store(s)

Write each declared store: human prose sections (overview, world rules
or method notes, pending canon, a Revisions log) around exactly 1 fenced canon-facts block
matching the skeleton for its template. Every entry passes the validation rules above. No
placeholders, no TBD.

## Step 5: Review gate and handoff

Present the draft, recommendation-first: name the entries you are least certain about.
Apply edits, then close with:

```
Saved: LORE.md and/or SOURCES.md (project root, per template)

Binding for the whole creative line:
- the lore-consistency gate and the citation/sources gate score work against them
- ferrox-lore-keeper is the SOLE writer of the fenced canon-facts block
- ferrox-continuity-checker reads them before flagging continuity breaks
- ferrox-chapter-drafter reads them before drafting any chapter
- ferrox-method-reviewer (research eye, lands Wave 4) audits SOURCES.md entries
- the executor files_to_read wiring (lands Wave 2) injects them into creative tasks
- the manuscript assembler resolves book/SPINE.md against them and compiles
  build/manuscript.md: `node ferrox-core/bin/lib/manuscript-assemble.cjs [projectDir]`
  (hard-errors on orphans in both directions; prints the compile report with
  chapter count, total words, and per-chapter words vs word_count_target)

The fenced block plus the Revisions log are machine-owned by the keeper; all other prose
stays human-owned, preserved byte for byte.
```

## Step 6: Retcon sweep (A3; runs whenever the canon-facts block changed on a project with landed chapters)

Fires on the update path here and after ANY ferrox-lore-keeper update-mode retcon that
returns a new `canon_facts_hash`. Receipts pinned to the old hash are VOID, not failed;
the sweep re-earns them deterministically:

1. Collect landed receipts: every chapter gate receipt records a `canon_facts_hash:` line
   (execute-phase step 5.9). Find them: `grep -rn "canon_facts_hash:" .planning/`.
2. Compare each receipt's hash against the keeper's new hash. Matching receipts stand.
   Every mismatch names an affected chapter.
3. Deterministic re-gate sweep: for each affected chapter, rebuild the gate bundle and
   re-run `node gates/lore-consistency/gate.cjs` exactly as execute-phase step 5.9 does.
   A PASS re-pins the receipt under the new hash; record the fresh receipt verbatim.
4. FAILs enter the resolve-or-waive loop with the named triad, recommendation first,
   human arbitrates:
   - **retcon the bible back:** ferrox-lore-keeper update mode reverses the change
   - **revise the chapter:** the A2 lane, ferrox-chapter-drafter revision mode, max 2
     passes, then stop honestly
   - **waive loud:** record the FAIL verbatim in the `## Continuity Waivers` section of
     the wave summary
5. The sweep itself is mechanical: no eye dispatch, no judgment pass. Any `INDET` lines it
   produces are recorded and carried into the next wave's continuity eyes cross-audit.

</process>

<success_criteria>
- [ ] Existing LORE.md or SOURCES.md never silently overwritten
- [ ] Domain resolved via the mapping table; null domain asked 1 recommendation-first question, then config-set
- [ ] Mode chosen with a recommendation
- [ ] Every entry checkable: typed values with chapter_id:line provenance
- [ ] Fenced canon-facts block exactly once per store, valid against the schema
- [ ] Stable-slug chapters and the spine manifest explained to the author
- [ ] Author approved the draft
- [ ] Store file(s) written to the project root
</success_criteria>
