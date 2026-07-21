---
name: ferrox-ns-ideate
description: "exploration capture | explore sketch spike spec capture"
allowed-tools:
  - Read
  - Skill
---


Route to the appropriate exploration / capture skill based on the user's intent.
`ferrox-note`, `ferrox-add-todo`, `ferrox-add-backlog`, and `ferrox-plant-seed` were folded
into `ferrox-capture` (with `--note`, default, `--backlog`, `--seed` modes) by
#2790. The capture target lists pending todos via `--list`.

| User wants | Invoke |
|---|---|
| Explore an idea or opportunity | ferrox-explore |
| Sketch out a rough design or plan | ferrox-sketch |
| Time-boxed technical spike | ferrox-spike |
| Write a spec for a phase | ferrox-spec-phase |
| Capture a thought (todo / note / backlog / seed) | ferrox-capture |

Invoke the matched skill directly using the Skill tool.
