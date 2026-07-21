---
name: ferrox-using-skills
description: Use when starting any conversation: invoke the relevant Ferrox discipline or GSD workflow skill before acting, including before clarifying questions.
---

> Adapted from Superpowers using-superpowers by Obra (MIT) — see NOTICE.

<!-- ferrox:skill-invocation-mandate -->

This is the fork's single skill-invocation mandate. It is the ONLY skill that carries the `<!-- ferrox:skill-invocation-mandate -->` marker; no discipline skill carries it.

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute one specific, already-scoped task, follow your dispatch instructions — this session-start mandate does not re-open the flow for you.
</SUBAGENT-STOP>

## The Rule

If there is even a real chance a skill applies to what you are about to do, you MUST invoke it **before responding or acting** — including before clarifying questions, exploring the codebase, or reading files. If the skill turns out to be wrong for the situation, you don't have to follow it, but you check first.

Then announce **"Using [skill] to [purpose]"** and follow the skill exactly. If it has a checklist, create a todo per item.

This is not negotiable. You cannot rationalize your way out of checking.

## The Ferrox Surfacing Model

Ferrox Factory is GSD's context-engineered lifecycle spine with Superpowers' per-task discipline as the floor. Two layers, both surfaced through this one mandate:

- **Macro flow — GSD lifecycle skills own the shape of the work:** discuss → plan → execute → verify (plus the phase/milestone/audit machinery). Route project-level intent through these; do not invent a competing process vocabulary.
- **Micro-discipline floor — the vendored Ferrox disciplines are the quality floor inside a task:**
  - `ferrox-test-driven-development` — before writing implementation code for any feature or bugfix.
  - `ferrox-systematic-debugging` — before proposing a fix for any bug, test failure, or unexpected behavior.
  - `ferrox-verification-before-completion` — before claiming work is complete, fixed, or passing; evidence before assertions, always.
  - `ferrox-requesting-code-review` — when completing tasks or major features, before merging.
  - `ferrox-receiving-code-review` — when acting on review feedback, before implementing suggestions.

The disciplines are normal discoverable skills. This mandate is the only thing that fires at session start; it points you at the right layer.

## Skill Priority

When multiple skills apply, process/lifecycle skills come first — they set the approach; discipline and implementation skills then carry it out.

- "Let's build X" → GSD discuss/plan flow sets the shape; `ferrox-test-driven-development` governs the code.
- "Fix this bug" → `ferrox-systematic-debugging` first, then the domain work.
- "Is this done?" → `ferrox-verification-before-completion` before any success claim.

## Red Flags

These thoughts mean STOP — you're rationalizing your way past a skill:

| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check for a skill. |
| "I need more context first" | The skill check comes BEFORE clarifying questions. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first. |
| "I can check git/files quickly" | Files lack conversation context. Check for a skill. |
| "This doesn't need a formal skill" | If a skill exists, use it. |
| "I remember this skill" | Skills evolve. Read the current version. |
| "The skill is overkill" | Simple things become complex. Use it. |
| "I'll just do this one thing first" | Check BEFORE doing anything. |
| "I know what that means" | Knowing the concept ≠ using the skill. Invoke it. |

## User Instructions Take Precedence

User instructions (CLAUDE.md, AGENTS.md, and direct requests from your human partner) **take precedence** over skills, which in turn override default behavior. Only skip a skill's workflow when your human partner has explicitly told you to. Skills discipline your defaults; they never override the human.
