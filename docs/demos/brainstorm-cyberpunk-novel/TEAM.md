# TEAM

The dynamic team roster (team-manifest/v1). Blessed at a brainstorm exit;
mutate through the governed add/remove/swap ops, never by hand.

```yaml team-manifest
schema: team-manifest/v1
derived_from:
  brainstorm: cyberpunk-novel-2026-07-23
  milestone: wetlease-novel-v1
manifest_hash: 2217ce11a06339bb110997d935fb1afe78534f2229855ed1818a71629290778d
roles:
  - id: lore-keeper
    charter: >-
      Keep the canon store: you alone write the LORE.md canon-facts block, recording every blessed world fact (the
      Ledger, provenance physics, the render-tax, the Estuary and the Drowned Registry, cast sheets) as checkable
      entries with chapter:line provenance, and you run the retcon sweep whenever canon moves.
    rationale: >-
      Because the Decisions lock hard world physics (copies worthless, value lives in the provenance chain, nothing
      outside the Ledger verifies a forgery) and the render-tax is plot-critical: this book dies by canon drift without
      a single keeper of record.
    non_redundancy: Sole owner of the LORE.md write surface; no other seat writes canon.
    provenance: '(stance: sounding-board, confirmed at exit)'
    binding:
      agent: ferrox-lore-keeper
    tier: null
    owns:
      - LORE.md
    reviews: []
    phase_scope: null
  - id: chapter-drafter
    charter: >-
      Draft and revise chapters against the planner-stamped chapter contract and the declared canon: salt-rot noir
      register, waterline settings, dialogue as bartering, every scene honoring the locked memory physics and the 3-week
      countdown.
    rationale: >-
      Because the Next Step is a drafted cold open and the captured shape is a full novel: the primary creation seat
      that turns the spine into prose.
    non_redundancy: Sole owner of the book/chapters/** write surface; the only seat that authors prose.
    provenance: '(stance: sounding-board, confirmed at exit)'
    binding:
      agent: ferrox-chapter-drafter
    tier: null
    owns:
      - book/chapters/**
    reviews: []
    phase_scope: null
  - id: continuity-checker
    charter: >-
      After each revise pass, check chapters against the canon store and each other for plot, character, timeline, and
      setting breaks: the countdown must pace correctly, the provenance-chain custody stamps must stay in order, and the
      render-tax decay must be monotonic; verdicts with chapter:line evidence, never prose edits.
    rationale: >-
      Because the Threads section is 4 interlocking payoff lines (chain, buy-back, sacrament, countdown) and the
      timestamp reveal must recolor every chapter behind it: a dedicated verification duty, not a drafting one.
    non_redundancy: Verification duty over book/chapters/** and LORE.md; writes nothing, so it can fail anything.
    provenance: '(stance: sounding-board, confirmed at exit)'
    binding:
      agent: ferrox-continuity-checker
    tier: null
    owns: []
    reviews:
      - book/chapters/**
      - LORE.md
    phase_scope: null
  - id: line-editor
    charter: >-
      Line-edit content-complete chapters for rhythm, clarity, repetition, and dialogue: sentences carry wet weight,
      dialogue barters even when tender, and the salt-rot register holds line by line; sentence-level notes only, never
      structural rewrites.
    rationale: >-
      Because the Tone section is a hard contract ("a stranger writing a scene from this page should reach for low
      light, standing water, and a negotiation that is really a confession") and register drift is the failure mode
      outlines cannot catch.
    non_redundancy: Sentence-level craft review, distinct from continuity fact-checking; reviews prose rhythm, not canon.
    provenance: '(stance: sounding-board, confirmed at exit)'
    binding:
      agent: ferrox-line-editor
    tier: null
    owns: []
    reviews:
      - book/chapters/**
    phase_scope: null
  - id: memory-economy-specialist
    charter: >-
      Own the memory-property tech bible under book/tech/: work out the Ledger notary mechanics, custody-stamp format,
      render-tax arithmetic, and the forgery-verification asymmetry as internally consistent rules; propose tech canon
      to the lore keeper and review chapters for any scene where the technology breaks its own economics.
    rationale: >-
      Because the world runs on an invented asset class (memory as papered property) and the hard edge (nothing outside
      the Ledger verifies a forgery) is load-bearing for the whole plot: this expertise has no registry agent and the
      seat must be chartered inline.
    non_redundancy: >-
      Distinct expertise and write surface: the lore keeper records blessed canon, this seat invents and stress-tests
      the tech economics under book/tech/** before anything reaches the canon store.
    provenance: '(stance: sounding-board, confirmed at exit)'
    binding:
      inline: true
    tier: frontier
    owns:
      - book/tech/**
    reviews:
      - LORE.md
      - book/chapters/**
    phase_scope: null
```
