# Ferrox Factory: the cheat sheet

Install once, then talk to it. Everything below runs inside your agent runtime
(Claude Code, Codex, Cursor and 14 others), not in a separate terminal.

```bash
npx ferrox-factory --claude --global     # or --local to scope it to one project
```

Check it landed: `ferrox-tools doctor`

---

## The 60 second version

Ferrox turns a goal into a roadmap, a roadmap into plans, and plans into shipped
increments, with gates that stop the build looping. You run 4 commands most days.

```
/ferrox-new-project      once, at the start
/ferrox-plan-phase       turn the next phase into executable plans
/ferrox-execute-phase    build it
/ferrox-verify-work      confirm it actually works
```

Everything else is a shortcut off that spine.

---

## Starting something

| You want | Say |
|---|---|
| A brand new project | `/ferrox-new-project` |
| A new milestone on an existing project | `/ferrox-new-milestone` |
| To think before committing | `/ferrox-brainstorm` |
| To hand it a spec or ADRs you already wrote | `/ferrox-ingest-docs` |
| To understand a codebase you inherited | `/ferrox-map-codebase` |

## The daily loop

| You want | Say |
|---|---|
| Plan the next phase | `/ferrox-plan-phase` |
| Build it | `/ferrox-execute-phase` |
| Build just one wave | `/ferrox-execute-phase --wave 2` |
| Check it works | `/ferrox-verify-work` |
| Where am I | `/ferrox-progress` |
| What is next | `/ferrox-next` |
| Small fix, skip the ceremony | `/ferrox-quick` |
| Something is broken | `/ferrox-debug` |

## Finishing

| You want | Say |
|---|---|
| Close the milestone | `/ferrox-complete-milestone` |
| Review before merge | `/ferrox-code-review` |
| Security pass | `/ferrox-secure-phase` |
| Write the docs | `/ferrox-docs-update` |
| Ship it | `/ferrox-ship` |

---

## The hierarchy, so the words mean something

```
Project
  └── Milestone      one at a time, the thing you are trying to achieve
       └── Phase     sequential, each one is a gate
            └── Wave parallel, plans that can run at once
                 └── Plan   one agent owns it, files do not overlap
                      └── Task  one atomic commit
```

Phases run in order. Waves inside a phase run at the same time. That is the whole
model.

---

## Running wide: fleet mode

A phase whose plans do not touch the same files can be built by several worker
processes at once instead of one agent taking turns.

```
/ferrox-execute-phase 12 --fleet
```

**You do not need the flag. Just say it.**

> "build phase 12 with the ferrox fleet"
> "use the fleet"
> "run it wide"

All resolve the fleet backend. "run it inline", "no fleet" and "one at a time"
all resolve inline. Whatever it infers, **it tells you before anything runs**,
naming the phrase that triggered it and how to override.

Three rules worth knowing:

1. **A backend you asked for behaves like a flag, not a preference.** If the
   fleet cannot run, the run REFUSES and executes nothing. It never quietly
   falls back and lets you believe you got a fleet.
2. **Mentioning the fleet is not asking for one.** "the fleet benchmark returned
   negative" requests nothing. The matcher is deliberately narrow.
3. **Only a config default falls back silently**, because a config value must
   never break an unattended build.

Precedence, highest first: the flag on this run, then what you asked for in
words, then `claude_orchestration.execution_backend` in `.planning/config.json`,
then the parallelism verdict, then inline.

### Should this phase run wide at all

```
node scripts/parallelism-verdict.cjs <phase>
```

It recommends fleet or inline and **it can say no**. A phase with a narrow
dependency graph returns inline, because worktrees, leases and land queueing are
not free. Wider is not automatically faster.

### Watching a fleet run

```
node scripts/fleet-glass.cjs watch <phase>    # live, repainting
node scripts/fleet-glass.cjs graph <phase>    # the dependency shape
node scripts/fleet-glass.cjs leases           # who holds what
```

All read only. They cannot alter a run.

---

## Your team

Planning produces a team of roles. Each role binds to an inline session or a
named agent, and `.planning/TEAM.md` is where that lives.

```
node scripts/fleet-crew.cjs roster     # every role and what backs it
node scripts/fleet-crew.cjs assign <phase>
```

`roster` spawns nothing. It is a view.

---

## When it gets stuck

Ferrox is built so the line always terminates. If a gate keeps failing, the
escalation menu offers: descope, split, change approach, accept with a written
fence, or park.

**"Try again" is not on the menu.** That is deliberate. Repeating a failing
attempt is how autonomous builds burn a night and produce nothing.

```
node scripts/fleet-foreman.cjs menu <phase>
```

---

## Things that will save you an hour

- **Run one test file:** `npm test -- --files tests/<name>.test.cjs`. Bare
  `npm test -- <name>` is not a thing and fails with an unhelpful message.
- **Test output is chunked.** Add up every `# tests` line. Never read the tail
  alone, it is one chunk of several.
- **Keep 1 install.** A global copy shadows a project-local one and they drift.
  `ferrox-tools doctor` prints both paths, both versions, and which is running.
- **A red test in a file you did not touch:** re-run that file alone first.
  Parallel suites contend for CPU and produce false reds.

---

## Getting help

```
/ferrox-help          every command
/ferrox-config        settings
/ferrox-health        is this project set up correctly
```
