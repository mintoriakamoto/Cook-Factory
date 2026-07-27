'use strict';
/**
 * ferrox-core.js — OpenCode native plugin adapter (the Ferrox hook bridge).
 *
 * Architecture: SUBPROCESS REUSE — this plugin reimplements NO guard logic.
 * It binds OpenCode's documented plugin event bus (opencode.ai/docs/plugins)
 * and spawns existing hook scripts as child processes, feeding each one the
 * Claude-dialect JSON payload it already understands on stdin and honoring
 * its verdict (exit code 2 and/or a {decision:'block'} / permissionDecision
 * JSON object on stdout blocks the tool call by throwing, which is how an
 * OpenCode plugin denies execution in tool.execute.before).
 *
 * Install layout (written by bin/install.js):
 *   <configDir>/plugins/ferrox-core.js   ← this file
 *   <configDir>/hooks/*.js               ← the staged hook scripts
 *   <configDir>/package.json             ← {"type":"commonjs"} marker, which is
 *     why this file is CommonJS: Bun's ESM/CJS interop imports module.exports
 *     properties as named exports, so OpenCode's plugin loader picks up
 *     `FerroxPlugin` either way.
 *
 * Event projection (the OPENCODE_EXTENSION_EVENTS subset Ferrox binds — see
 * src/host-integration.cts): session.created → SessionStart; session.idle →
 * Stop; experimental.session.compacting → PreCompact; tool.execute.before →
 * PreToolUse; tool.execute.after → PostToolUse; file.edited → FileChanged.
 *
 * Failure stance: the bridge is FAIL-OPEN for its own defects (a missing hook
 * script, a spawn error, malformed hook stdout never breaks the host session)
 * but faithfully propagates an explicit BLOCK verdict from a guard. Guards
 * that must fail closed do so inside the guard process itself.
 *
 * Kilo Code note: .kilo/plugins/ferrox-core.js is this file copied verbatim
 * (Kilo is an OpenCode fork sharing the same plugin event bus — #2093).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// plugins/ferrox-core.js → sibling hooks/ dir at the configDir root.
const HOOKS_DIR = path.join(__dirname, '..', 'hooks');

// Re-projection of hooks/hooks.json onto the host bus. Matchers are
// case-insensitive supersets of the Claude registrations (OpenCode tool ids
// are lowercase; 'shell'/'local_shell' are other AGENTS.md-runtime spellings
// the guards themselves also accept). Each guard re-validates tool_name from
// the payload, so a superset spawn is safe — a non-applicable guard no-ops.
const PRE_TOOL_HOOKS = [
  { matcher: /^(write|edit|multiedit|patch)$/i, script: 'ferrox-prompt-guard.js', timeoutMs: 5000 },
  { matcher: /^(write|edit|multiedit|patch)$/i, script: 'ferrox-read-guard.js', timeoutMs: 5000 },
  { matcher: /^(write|edit|multiedit|patch)$/i, script: 'ferrox-worktree-path-guard.js', timeoutMs: 5000 },
  { matcher: /^(bash|shell|local_shell)$|merge_pull_request|push_files|create_or_update_file/i, script: 'ferrox-merge-gate-guard.js', timeoutMs: 15000 },
];
const POST_TOOL_HOOKS = [
  { matcher: /^(bash|shell|local_shell|edit|write|multiedit|patch|agent|task)$/i, script: 'ferrox-context-monitor.js', timeoutMs: 10000 },
  { matcher: /^(read|webfetch|websearch|fetch)$/i, script: 'ferrox-read-injection-scanner.js', timeoutMs: 5000 },
];
const SESSION_START_HOOKS = [
  { script: 'ferrox-ensure-canonical-path.js', timeoutMs: 5000 },
  { script: 'ferrox-check-update.js', timeoutMs: 30000 },
];
const STOPLIKE_HOOKS = [
  { script: 'ferrox-context-monitor.js', timeoutMs: 10000 },
];

/**
 * Spawn one staged hook script with a Claude-dialect payload on stdin.
 * Returns { blocked, reason } — never throws (fail-open for bridge defects).
 * `hooksDir` is injectable for tests; production callers use the staged dir.
 */
function runHook(script, payload, timeoutMs, cwd, hooksDir = HOOKS_DIR) {
  const scriptPath = path.join(hooksDir, script);
  try {
    if (!fs.existsSync(scriptPath)) return { blocked: false, reason: null };
    const res = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: timeoutMs,
      cwd: cwd || process.cwd(),
      env: { ...process.env, FERROX_HOST_BRIDGE: 'opencode' },
      windowsHide: true,
    });
    let verdict = null;
    if (res.stdout) {
      try { verdict = JSON.parse(res.stdout); } catch { /* non-JSON advisory output */ }
    }
    const jsonBlock = !!verdict && (
      verdict.decision === 'block' ||
      (verdict.hookSpecificOutput && verdict.hookSpecificOutput.permissionDecision === 'deny')
    );
    if (res.status === 2 || jsonBlock) {
      const reason =
        (verdict && (verdict.reason ||
          (verdict.hookSpecificOutput && verdict.hookSpecificOutput.permissionDecisionReason))) ||
        (res.stderr && res.stderr.trim()) ||
        `${script} blocked the tool call`;
      return { blocked: true, reason };
    }
  } catch { /* spawn failure — bridge defect, fail open */ }
  return { blocked: false, reason: null };
}

/** Run every registration whose matcher accepts toolName; throw on a block. */
function runToolHooks(registrations, toolName, payload, cwd) {
  for (const reg of registrations) {
    if (!reg.matcher.test(String(toolName || ''))) continue;
    const { blocked, reason } = runHook(reg.script, payload, reg.timeoutMs, cwd);
    if (blocked) {
      const err = new Error(reason);
      err.name = 'FerroxGateError';
      throw err;
    }
  }
}

/** OpenCode plugin entry point. */
const FerroxPlugin = async ({ directory, worktree } = {}) => {
  const cwd = worktree || directory || process.cwd();
  const base = { cwd };

  return {
    event: async ({ event } = {}) => {
      const type = event && event.type;
      const sessionId = event && event.properties && event.properties.sessionID;
      if (type === 'session.created') {
        for (const reg of SESSION_START_HOOKS) {
          runHook(reg.script, {
            ...base, hook_event_name: 'SessionStart', source: 'startup', session_id: sessionId,
          }, reg.timeoutMs, cwd);
        }
      } else if (type === 'session.idle' || type === 'experimental.session.compacting') {
        const name = type === 'session.idle' ? 'Stop' : 'PreCompact';
        for (const reg of STOPLIKE_HOOKS) {
          runHook(reg.script, {
            ...base, hook_event_name: name, session_id: sessionId,
          }, reg.timeoutMs, cwd);
        }
      } else if (type === 'file.edited') {
        const file = event && event.properties && event.properties.file;
        if (file && path.basename(String(file)) === 'config.json') {
          runHook('ferrox-config-reload.js', {
            ...base, hook_event_name: 'FileChanged', file_path: file, session_id: sessionId,
          }, 8000, cwd);
        }
      }
    },

    'tool.execute.before': async (input = {}, output = {}) => {
      runToolHooks(PRE_TOOL_HOOKS, input.tool, {
        ...base,
        hook_event_name: 'PreToolUse',
        session_id: input.sessionID,
        tool_name: input.tool,
        tool_input: output.args || {},
      }, cwd);
    },

    'tool.execute.after': async (input = {}, output = {}) => {
      runToolHooks(POST_TOOL_HOOKS, input.tool, {
        ...base,
        hook_event_name: 'PostToolUse',
        session_id: input.sessionID,
        tool_name: input.tool,
        tool_input: (output && output.args) || {},
        tool_response: { output: output && output.output, title: output && output.title },
      }, cwd);
    },
  };
};

module.exports = { FerroxPlugin };
// Test seams (not part of the OpenCode plugin surface).
module.exports._internal = { runHook, runToolHooks, PRE_TOOL_HOOKS, POST_TOOL_HOOKS, SESSION_START_HOOKS, HOOKS_DIR };
