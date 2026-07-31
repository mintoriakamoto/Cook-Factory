<purpose>
One-page newcomer-oriented tour of Ferrox Factory. Output ONLY the `<reference>` content below. No additions.
</purpose>

<reference>
# Ferrox Factory. Spec in. Proven software out.

Plan-driven development for solo agentic work with Claude Code. Ferrox Factory turns a vague idea into a hierarchical plan, then executes it phase by phase with state tracking and atomic commits.

## Never done this before? Start with 2 commands

```text
/ferrox:new-project                 # describe what you want. Ends by offering to build it
/ferrox:progress --next --auto      # build every step, without stopping to ask what is next
```

`--auto` is the whole point: it keeps going by itself and pauses only when a real decision is
needed. `/ferrox:new-project` offers it to you at the end, so on a new project you never have to
type it. Stop it any time with `/ferrox:pause-work`.

Already have a codebase? Start with `/ferrox:onboard` instead, which maps the repo and sets up
planning without touching your code.

## The 9 that carry you end to end

These answer the 9 questions a first project actually raises. Everything else is optional.

| Command | The question it answers |
|---|---|
| `/ferrox:new-project` | What do you want to build |
| `/ferrox:progress --next --auto` | Build it, all of it, without me steering |
| `/ferrox:next` | Where am I and what should I do now |
| `/ferrox:plan-phase <N>` | Work out the next step in detail |
| `/ferrox:execute-phase <N>` | Build that one step now |
| `/ferrox:verify-work <N>` | Did it actually work |
| `/ferrox:ship <N>` | Send it. Opens a PR from the finished step |
| `/ferrox:debug "<symptom>"` | It broke. Survives `/clear` |
| `/ferrox:undo` | Put it back the way it was |

Install only these with `npx ferrox-factory@latest --profile=beginner`. The default install gives
you all 74 commands, so nothing you read about is ever missing.

## When you step away

| Command | Purpose |
|---|---|
| `/ferrox:pause-work` | Stop cleanly and write a handoff you can come back to |
| `/ferrox:resume-work` | Pick up exactly where you left off |
| `/ferrox:health` | Check whether this project is set up correctly |

## Common commands

| Command | Purpose |
|---|---|
| `/ferrox:progress` | Where am I, what's next. Also routes freeform intent with `--do "..."` |
| `/ferrox:quick` | Small ad-hoc task with Ferrox guarantees (planning dir + atomic commit) |
| `/ferrox:fast "<task>"` | Trivial inline change, no subagents, 3 file edits or fewer |
| `/ferrox:discuss-phase <N>` | Capture vision and decisions before planning |
| `/ferrox:brainstorm [topic] [--research]` | Topic brainstorm in 3 silent stances (guided, generative, sounding board) with research and visual companion on tap, saved to `.planning/brainstorms/{slug}-{date}/`, then routed |
| `/ferrox:capture` | Save an idea, todo, note, seed, or backlog item |
| `/ferrox:help --full` | Complete reference (every command, every flag) |

## A note on the word "phase"

A phase is one step of your build: plan it, build it, confirm it, then the next one. The commands
say phase because the planning files do. If you only ever use `--auto`, you will not need the word.

## Want more?

```text
/ferrox:help --brief         # 10-line refresher of top commands
/ferrox:help --full          # complete reference
/ferrox:help <topic>         # one section only — see topics below
/ferrox:help --brief <topic> # compact scoped lookup — signature + one-line summary
```

Topics: `workflow` · `planning` · `execute` · `quick` · `debug` · `capture` · `ship` · `config` · `milestones` · `spike` · `sketch` · `design` · `review` · `audit` · `progress`

## Update Ferrox

```bash
npx ferrox-factory@latest
```
</reference>
