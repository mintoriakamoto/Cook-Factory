# Ferrox Factory — Project Brief (LOCKED v1.0)

> Seed artifact for GSD project ingestion. This is the frozen output of research → design → 3-lens cross-audit → Plan-Lock. It is not to be re-brainstormed; it is to be imported.

## What it is
Ferrox Factory is an agentic build system — a **fork of GSD (`open-gsd/gsd-core`, MIT)** hardened into a line that reliably ships correct increments **fast, coordinated, and strong**, without the infinite audit/fix/re-plan loop that killed the prior homegrown systems (IJFW, Wayland Strike, the Rust Ferrox Factory). Product name: **Ferrox Factory**. Fork/repo: **`ferrox-core`**.

## The three goals (each backed by a hard mechanism, not an aspiration)
- **Fast** — bounded loops (wall-clock + pass caps), fresh context per task (no rot), mixed-tier model routing, RTK, human-SLA auto-park, capped merge queue.
- **Coordinated** — one-writer worktrees, runtime-enforced file ownership, hot-seam serialization, orchestrator as sole writer of state/backlog/migration-numbers.
- **Strong** — independent severity judge, red-green receipts, mutation gate, security-never-backlogged, escalate-dissent, net-backlog-can't-grow floor.

## Governing rule
No stage says "until clean." Every gate has a pass-cap AND a wall-clock budget (whichever fires first), and exactly one of three cap-outcomes: **ship-with-backlog | stop-and-rescope | escalate-to-human**. Terminal metric = "did a coverage-advancing increment land today," never "is it proven."

## The Build Line (pipeline)
0. **Frame & Recall** — pull prior decisions from bi-temporal KG memory + backlog intake gate. Don't re-derive.
1. **Brainstorm** — Superpowers Socratic + anti-scope → human-approved DESIGN.md. HARD GATE.
2. **Research** — adaptive budget (novelty score authorizes a 2nd pass) → RESEARCH.md.
3. **Plan** — GSD plan-phase + Superpowers writing-plans (TDD-structured, exact paths, files_modified declared) → PLAN.md + VALIDATION.md.
4. **🔒 PLAN-LOCK** — plan-checker + Trident gap-audit with **escalate-dissent** (lone CRITICAL/HIGH forces human review, not outvoted). Zero CRITICAL/HIGH → FREEZE + tag baseline. Rescope capped at 2, each strictly shrinking scope, then hard-descope-or-kill.
5. **Execute** — GSD waves, one-writer git-worktree per agent, fresh context, TDD (committed red-green receipt required). Intra-task tiering is sequential hand-off, never concurrent writers. Drift → backlog packet, not inline fix.
6. **⚖️ WAVE-AUDIT** — independent frontier judge assigns severity/risk (never the author). CRITICAL/HIGH fix now (cap 3 → escalate-human); MEDIUM/LOW → backlog EXCEPT security-category (never auto-backlog); clustered MEDIUMs on one surface → synthesized HIGH.
7. **Merge** — serial queue, capped at 3 rebase-reproof cycles (failure ejects worktree to backlog, no head-of-line block) + post-merge build/test gate. Hot-seam paths globally serialized; migration numbers orchestrator-allocated.
8. **Verify** — GSD goal-backward verifier (read-only, claims≠evidence) + Superpowers verification-before-completion + mutation gate on VALIDATION coverage.
9. **Ship** — Tier-2 human authorization (SLA'd: breach → auto-park increment, pull next forward).
10. **Learn** — extract-learnings → bi-temporal KG.

**Ship Clock:** nothing landed in the timebox → RED → autonomously descope to passing subset and merge (no human in path). No-op merges don't count.

## Model tiering
- **Frontier** (Opus 4.8 / GPT-5-class / Gemini frontier): brainstorm convergence, plan authoring, PLAN-LOCK judgment, severity judge, goal-backward verify, ship review, Trident panel.
- **Mid** (Sonnet-class): wave implementers, code-review pass.
- **Small** (Haiku-class): grunt — reads, mapping, test scaffolding (mutation-gated), receipt collection, summarization, state transcription.
- Routing: adaptive profile per stage; failure-escalation capped at ONE hop (small→mid→frontier); risk-graded (auth/crypto/payments/PII/deserialization/net-file boundaries forced high-risk + Trident regardless of self-grade; random spot-Trident on mid-risk); cross-lineage Trident (different model families); RTK underneath.

## Sourcing map
- **GSD (spine, forked):** lifecycle, roadmap/phases, wave-parallel execution, worktree isolation, serial merge queue + post-merge gate, goal-backward verifier, sole-writer state, model-profiles, mempalace seam, fresh-context-per-task.
- **Superpowers (discipline floor, vendored MIT):** brainstorming, writing-plans, TDD, subagent-driven-development, systematic-debugging, verification-before-completion, requesting/receiving-code-review. ONE skill-invocation mandate wins (resolve GSD/SP/IJFW bootstrap collision).
- **Grafted (yours):** cross-lineage Trident at 2 bounded checkpoints; bi-temporal KG behind mempalace seam; RTK; two-tier human authorization.
- **Re-imported from Strike (only 2 pieces):** hot-seam serialization; lightweight red-green receipts (mechanical enforcement where cheap — NOT the 36K-LOC crypto engine).
- **Cut/deferred:** IJFW-as-framework (retired to parts donor); Ferrox Rust cryptographic-enforcement engine (optional high-risk backend, Phase-3-of-future only); Strike's 6-state ladder + loop-until-zero (replaced by capped gates).

## Proposed roadmap (milestone: Ferrox Factory v1.0)
1. **Fork & baseline** — fork gsd-core → ferrox-core; clean install/run; MIT; rename surface.
2. **Discipline floor** — vendor Superpowers skills; resolve single skill-invocation mandate (kill bootstrap collision).
3. **Halting layer** — the caps: per-gate wall-clock + pass caps, global rescope attempt-counter, human-SLA auto-park, Ship Clock teeth. (Early — it's what makes everything after it terminate.)
4. **Coordination hardening** — one-writer worktrees, files_modified runtime enforcement, hot-seam registry, orchestrator migration-number allocation.
5. **Strength gates** — independent severity judge, red-green receipts, mutation gate, security-never-backlog, backlog intake + burn-down floor.
6. **Model-tiering + Trident** — adaptive routing, one-hop escalation, risk-grading, cross-lineage Trident (upgrade gsd-review), RTK wiring.
7. **Memory graft** — bi-temporal KG behind mempalace seam; Frame&Recall + Learn wiring.
8. **Dogfood** — point Ferrox Factory at a real Wayland/Core feature; ship ONE increment through the full line. Proof = a merge, not an audit.
