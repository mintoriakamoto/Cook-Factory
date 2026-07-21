'use strict';

/**
 * Authoritative list of Ferrox-managed hook files.
 *
 * Extracted from the worker script into a shared CJS module so that:
 *  1. ferrox-check-update-worker.js can require() it directly (no source-level
 *     duplication).
 *  2. Tests can assert against the exported array instead of regex-parsing
 *     the worker source (retiring the pending-migration-to-typed-ir token
 *     on managed-hooks.test.cjs and orphaned-hooks.test.cjs, per #455).
 *
 * These are the files Ferrox ships into ~/.claude/hooks/ (or equivalent) and
 * checks for staleness after an update. Orphaned files from removed features
 * (e.g., ferrox-intel-*.js) must NOT be listed here — that would cause permanent
 * stale warnings for users who haven't cleaned up manually (#1750).
 */
const MANAGED_HOOKS = [
  'ferrox-check-update-worker.js',
  'ferrox-check-update.js',
  'ferrox-config-reload.js',
  'ferrox-context-monitor.js',
  'ferrox-cursor-post-tool.js',
  'ferrox-cursor-pre-tool.js',
  'ferrox-cursor-session-start.js',
  'ferrox-cursor-stop.js',
  'ferrox-cursor-subagent-start.js',
  'ferrox-cursor-subagent-stop.js',
  'ferrox-ensure-canonical-path.js',
  'ferrox-graphify-update.sh',
  'ferrox-merge-gate-guard.js',
  'ferrox-phase-boundary.sh',
  'ferrox-prompt-guard.js',
  'ferrox-read-guard.js',
  'ferrox-read-injection-scanner.js',
  'ferrox-session-state.sh',
  'ferrox-statusline.js',
  'ferrox-update-banner.js',
  'ferrox-validate-commit.sh',
  'ferrox-windsurf-pre-command.js',
  'ferrox-windsurf-pre-write.js',
  'ferrox-workflow-guard.js',
  'ferrox-worktree-path-guard.js',
];

module.exports = { MANAGED_HOOKS };
