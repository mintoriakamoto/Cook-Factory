# Instructions for Ferrox

- Use the ferrox-core skill when the user asks for Ferrox or uses a `ferrox-*` command.
- Treat `/ferrox-...` or `ferrox-...` as command invocations and load the matching file from `.github/skills/ferrox-*`.
- When a command says to spawn a subagent, prefer a matching custom agent from `.github/agents`.
- Do not apply Ferrox workflows unless the user explicitly asks for them.
- After completing any `ferrox-*` command (or any deliverable it triggers: feature, bug fix, tests, docs, etc.), ALWAYS: (1) offer the user the next step by prompting via `ask_user`; repeat this feedback loop until the user explicitly indicates they are done.
