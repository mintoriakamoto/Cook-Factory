# AGENTS.md

This file follows the open AGENTS.md spec (https://agents.md/) and is the
canonical agent-instructions surface for this project. Platform-specific
files (`.claude/CLAUDE.md`, `GEMINI.md`) carry the same operating rules for
their respective runtimes.

## What this project is

Ferrox Factory is an agentic build system — a fork of GSD (`open-gsd/gsd-core`,
MIT) hardened into a delivery line that ships correct software increments fast,
coordinated, and strong. It is markdown skills/agents plus a Node CLI
(`ferrox-core/bin/ferrox-tools.cjs`), not a compiled application. Core value:
a shippable, coverage-advancing increment lands on `main` every working
session, and the build never enters an unbounded audit→fix→re-plan loop.

## Workflow

Work is driven by the `/ferrox-*` slash commands (sources under
`commands/ferrox/`). Start work through a Ferrox command so planning artifacts
and execution context stay in sync — do not make direct repo edits outside a
Ferrox workflow unless explicitly asked to bypass it. Common entry points:

- `/ferrox-quick` — small fixes, doc updates, ad-hoc tasks
- `/ferrox-debug` — investigation and bug fixing
- `/ferrox-new-project` — initialise a project and gather deep context
- `/ferrox-plan-phase <N>` — produce a detailed phase plan with a verification loop
- `/ferrox-execute-phase <N>` — execute a phase's plans with wave-based parallelism
- `/ferrox-progress` — the unified situational command when unsure what to do next
- `/ferrox-verify-work` — validate built features through conversational UAT
- `/ferrox-ship` — open a PR, run review, and prepare for merge
- `/ferrox-help` — list every available command

Treat `.planning/` as the source of truth for project state — read it before
acting and keep it current as work progresses.

## Building and testing

- Node >= 22 is required (`engines` in package.json).
- TypeScript sources live in `src/*.cts` and compile to
  `ferrox-core/bin/lib/*.cjs` via `npm run build:lib` — never hand-edit the
  compiled `.cjs` outputs.
- `npm test` — full suite via `scripts/run-tests.cjs` (suites: unit,
  integration, install, security, slow).
- `npm run lint:ci` — the aggregate lint + drift gate chain.
- `npm run build` — full build including the `gen:*` generated artifacts;
  `npm run lint:generated-sync` verifies committed generated files are current.

## Conventions

- Prefer the smallest change that satisfies the phase's verification criteria;
  keep commits atomic and test-backed.
- Run the project's tests and linters before declaring work done.
- MIT license throughout; preserve GSD and Superpowers attribution (see
  `NOTICE` and the credit lines in `skills-vendored/*/SKILL.md`).
