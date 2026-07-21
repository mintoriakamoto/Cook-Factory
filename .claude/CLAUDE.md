<!-- GSD:project-start source:PROJECT.md -->

## Project

**Ferrox Factory**

Ferrox Factory is an agentic build system — a fork of GSD (`open-gsd/gsd-core`, MIT) hardened into a delivery line that reliably ships correct software increments **fast, coordinated, and strong**. It fuses GSD's context-engineered lifecycle spine with Superpowers' per-task discipline and a set of anti-loop forcing functions, so autonomous parallel sub-agents build real work without the infinite audit→fix→re-plan loop that stalled the prior homegrown systems. It is for Sean (and later, teams) building production software with fleets of coordinated AI agents.

**Core Value:** A shippable, coverage-advancing increment lands on `main` every working session — the line always terminates and always moves forward. If everything else fails, this must hold: **the build never enters an unbounded loop.**

### Constraints

- **Tech stack**: Fork of GSD — markdown skills/agents + Node CLI (`ferrox-tools.cjs` lineage). Superpowers skills vendored as markdown. Not a Rust rewrite.
- **License**: MIT throughout (GSD MIT + Superpowers MIT). Preserve attribution.
- **Runtime**: Claude Code first-class (worktree isolation, subagents, AskUserQuestion). Other runtimes best-effort inherited from GSD, not a v1.0 target.
- **Process**: The system must be built *using its own discipline* — bounded gates, no unbounded audit loops. Dogfooding is the acceptance test.
- **Location**: Lives at `~/dev/ferroxfactory/core` (its own git repo); the parked Rust `ferroxfactory/repo` is untouched.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->

## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## Ferrox Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a Ferrox command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/ferrox-quick` for small fixes, doc updates, and ad-hoc tasks
- `/ferrox-debug` for investigation and bug fixing
- `/ferrox-execute-phase` for planned phase work

Do not make direct repo edits outside a Ferrox workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/ferrox-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
