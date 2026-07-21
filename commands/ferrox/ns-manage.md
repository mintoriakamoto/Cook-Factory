---
name: ferrox-manage
description: "config workspace | workstreams thread update ship inbox"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [config, workspace, workstreams, thread, pause-work, resume-work, update, ship, inbox, pr-branch, undo, cleanup, health, manager, settings, stats, surface, help]
---

Route to the appropriate management skill based on the user's intent.
`ferrox-config` (settings + advanced + integrations + profile) and `ferrox-workspace`
(new + list + remove) are post-#2790 consolidated entries.

| User wants | Invoke |
|---|---|
| Configure Ferrox settings (basic / advanced / integrations / profile) | ferrox-config |
| Manage workspaces (create / list / remove) | ferrox-workspace |
| Manage parallel workstreams | ferrox-workstreams |
| Continue work in a fresh context thread | ferrox-thread |
| Pause current work | ferrox-pause-work |
| Resume paused work | ferrox-resume-work |
| Update the Ferrox installation | ferrox-update |
| Ship completed work | ferrox-ship |
| Process inbox items | ferrox-inbox |
| Create a clean PR branch | ferrox-pr-branch |
| Undo the last Ferrox action | ferrox-undo |
| Archive accumulated phase directories | ferrox-cleanup |
| Diagnose planning directory health | ferrox-health |
| Open the interactive command center | ferrox-manager |
| Configure workflow toggles and model profile | ferrox-settings |
| Show project statistics | ferrox-stats |
| Toggle which skills are surfaced | ferrox-surface |
| Show the Ferrox command guide | ferrox-help |

Invoke the matched skill directly using the Skill tool.
