---
name: ferrox:pr-branch
description: "You want a PR branch without the .planning/ commits, so reviewers see only real code"
argument-hint: "[target branch, default: main]"
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
requires: [review]
---

<objective>
Create a clean branch suitable for pull requests by filtering out .planning/ commits
from the current branch. Reviewers see only code changes, not Ferrox planning artifacts.

This solves the problem of PR diffs being cluttered with PLAN.md, SUMMARY.md, STATE.md
changes that are irrelevant to code review.
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/pr-branch.md
</execution_context>

<process>
Execute end-to-end.
</process>
