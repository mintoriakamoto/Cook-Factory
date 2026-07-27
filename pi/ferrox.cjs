'use strict';
/**
 * ferrox.cjs — pi (pi.dev) native extension adapter (ADR-1239 / #2102 Stage 1).
 *
 * Architecture: SUBPROCESS REUSE — same stance as the OpenCode bridge
 * (.opencode/plugins/ferrox-core.js): no guard logic is reimplemented here.
 * The extension binds pi's ExtensionAPI event bus (`pi.on`) and spawns the
 * staged Ferrox hook scripts as child processes with the Claude-dialect JSON
 * payload they already understand on stdin.
 *
 * Stage 1 scope: binds the single `tool_call` event and projects it onto the
 * PreToolUse guard set. The full ~30-event pi vocabulary is declared in
 * capabilities/pi/capability.json (extensionEvents: "pi") for later stages.
 *
 * Hook script resolution: pi is a pluginOnlyInstall runtime (only this file
 * is installed, at ~/.pi/agent/extensions/ferrox.cjs), so unlike OpenCode
 * there is no sibling hooks/ dir by construction. Resolution order:
 *   1. $FERROX_HOOKS_DIR (explicit override)
 *   2. ../hooks relative to this file (present if a fuller install staged it)
 * If neither resolves, the extension is a silent no-op — fail-open: a missing
 * staging must never break the host session. Guards that must fail closed do
 * so inside the guard process itself once it runs.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function resolveHooksDir() {
  const candidates = [
    process.env.FERROX_HOOKS_DIR,
    path.join(__dirname, '..', 'hooks'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

const PRE_TOOL_HOOKS = [
  { matcher: /^(write|edit|multiedit|patch)$/i, script: 'ferrox-prompt-guard.js', timeoutMs: 5000 },
  { matcher: /^(write|edit|multiedit|patch)$/i, script: 'ferrox-read-guard.js', timeoutMs: 5000 },
  { matcher: /^(write|edit|multiedit|patch)$/i, script: 'ferrox-worktree-path-guard.js', timeoutMs: 5000 },
  { matcher: /^(bash|shell|local_shell)$/i, script: 'ferrox-merge-gate-guard.js', timeoutMs: 15000 },
];

/** Spawn one hook; { blocked, reason }; never throws (fail-open bridge). */
function runHook(hooksDir, script, payload, timeoutMs) {
  try {
    const scriptPath = path.join(hooksDir, script);
    if (!fs.existsSync(scriptPath)) return { blocked: false, reason: null };
    const res = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, FERROX_HOST_BRIDGE: 'pi' },
      windowsHide: true,
    });
    let verdict = null;
    if (res.stdout) {
      try { verdict = JSON.parse(res.stdout); } catch { /* advisory output */ }
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
  } catch { /* spawn failure — fail open */ }
  return { blocked: false, reason: null };
}

/** pi ExtensionAPI entry point. */
function activate(pi) {
  if (!pi || typeof pi.on !== 'function') return;
  const hooksDir = resolveHooksDir();
  if (!hooksDir) return; // nothing staged to bridge to — no-op install

  pi.on('tool_call', async (ev = {}) => {
    const toolName = ev.toolName || ev.tool || ev.name || '';
    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: ev.sessionId || ev.sessionID,
      cwd: ev.cwd || process.cwd(),
      tool_name: toolName,
      tool_input: ev.args || ev.input || {},
    };
    for (const reg of PRE_TOOL_HOOKS) {
      if (!reg.matcher.test(String(toolName))) continue;
      const { blocked, reason } = runHook(hooksDir, reg.script, payload, reg.timeoutMs);
      if (blocked) {
        const err = new Error(reason);
        err.name = 'FerroxGateError';
        throw err;
      }
    }
  });
}

module.exports = activate;
module.exports.activate = activate;
// Test seams (not part of the pi extension surface).
module.exports._internal = { resolveHooksDir, runHook, PRE_TOOL_HOOKS };
