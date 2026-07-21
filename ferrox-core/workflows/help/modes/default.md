<purpose>
One-page newcomer-oriented tour of Ferrox Core. Output ONLY the `<reference>` content below. No additions.
</purpose>

<reference>
# Ferrox Core — Git. Ship. Done.

Plan-driven development for solo agentic work with Claude Code. Ferrox Core turns a vague idea into a hierarchical plan, then executes it phase by phase with state tracking and atomic commits.

## Start here (3 commands)

```text
/ferrox:new-project        # Greenfield: questioning → research → requirements → roadmap
/ferrox:onboard            # Existing codebase: map → ingest docs → initialize planning
/ferrox:plan-phase 1       # Create a detailed plan for phase 1
/ferrox:execute-phase 1    # Execute all plans in the phase
```

Existing codebase? Run `/ferrox:onboard` to map the repo, ingest existing docs, and initialize planning safely.

## Common commands

| Command | Purpose |
|---|---|
| `/ferrox:progress` | Where am I, what's next — also routes freeform intent with `--do "..."` |
| `/ferrox:quick` | Small ad-hoc task with Ferrox guarantees (planning dir + atomic commit) |
| `/ferrox:fast "<task>"` | Trivial inline change — no subagents, ≤3 file edits |
| `/ferrox:discuss-phase <N>` | Capture vision and decisions before planning |
| `/ferrox:debug "<symptom>"` | Persistent debug session, survives `/clear` |
| `/ferrox:capture` | Save an idea, todo, note, seed, or backlog item |
| `/ferrox:verify-work <N>` | Conversational UAT for a completed phase |
| `/ferrox:ship <N>` | Open a PR from a completed phase |
| `/ferrox:help --full` | Complete reference (every command, every flag) |

## Want more?

```text
/ferrox:help --brief         # 10-line refresher of top commands
/ferrox:help --full          # complete reference
/ferrox:help <topic>         # one section only — see topics below
/ferrox:help --brief <topic> # compact scoped lookup — signature + one-line summary
```

Topics: `workflow` · `planning` · `execute` · `quick` · `debug` · `capture` · `ship` · `config` · `milestones` · `spike` · `sketch` · `review` · `audit` · `progress`

## Update Ferrox

```bash
npx ferrox-core@latest
```
</reference>
