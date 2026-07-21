#!/usr/bin/env node
// ferrox-hook-version: {{FERROX_VERSION}}
// Ferrox Merge-Gate Guard — PreToolUse hook (FF-B10)
// Covers all KNOWN merge/ship/release vectors and FAILS CLOSED at the tool layer.
//
// HONEST SCOPE (do not overclaim). This hook is a client-side COMMAND/TOOL matcher.
// It intercepts every merge vector we know about and blocks the tool call unless the
// strength gate returns pass. It is NOT cryptographically un-bypassable: an arbitrary
// shell script, an aliased binary, or a novel tool the matcher does not recognize can
// still evade a command matcher. The cryptographically-un-bypassable layer is
// SERVER-SIDE branch protection / a pre-receive hook — a publish-time item (FF-B17).
// The accurate claim is: "covers known merge vectors + fails closed at the tool
// layer"; it is not "merging is impossible."
//
// Problem: strength.merge-gate (Plan 07) is only a verdict a caller must remember
// to invoke. A forgetful or rogue agent can merge/ship/release WITHOUT ever
// consulting it — "consulted" was never "enforced".
//
// This hook intercepts the merge/ship/release tool call itself. Claude Code
// PreToolUse can BLOCK a tool call (exit 2), so a merge that lacks the evidence is
// genuinely stopped at the tool boundary — the caller cannot skip the gate via any
// KNOWN vector.
//
// Triggers on (Bash tool):
//   - `git merge ...`         (excluding `git merge-base`)
//   - `gh pr merge ...`
//   - `git pull ...`          (fetch + merge is a merge vector)
//   - `git rebase ...`        (integrates/rewrites; excludes --abort/--continue/etc.)
//   - `git push` to a protected branch (main/master/release/*), a release tag
//     (`--tags` / `refs/tags/...` / `HEAD:main`), OR a bare / HEAD push while the
//     current branch is protected
// Triggers on (GitHub MCP tools — PreToolUse can match non-Bash tools):
//   - mcp__com-github-github-mcp-server__merge_pull_request  (always)
//   - mcp__com-github-github-mcp-server__push_files          (branch is protected)
//   - mcp__com-github-github-mcp-server__create_or_update_file (branch is protected)
// For any OTHER tool call (ordinary work) the hook is a benign no-op (exit 0).
//
// FAIL CLOSED (the inversion of the worktree guard's "error → silent pass"):
// once a merge op is detected, the hook shells out to
//   ferrox-tools query strength.merge-gate --raw
// (resolved relative to this hook, invoked against the project cwd) and ALLOWS
// (exit 0) ONLY when the verb's stdout parses AND decision === 'pass'. A missing
// evidence manifest, a missing/erroring verb, a non-zero exit, unparseable output,
// a non-pass decision, or ANY thrown error while gating → BLOCK (exit 2). For a
// merge op, an error is NEVER a pass-through.
//
// Evidence source: the increment-context flags the merge-gate verb requires
// (--increment/--requirements/--declared/--actual/--files/--opened/--resolved/
// --mutation-test/--mutation-flipped, plus optional --hot-seam-serialized/
// --findings/--items/--migration-number) are read from an on-disk evidence manifest
// written by the increment's earlier steps: `.planning/strength/merge-gate-request.json`
// (relocatable via config `strength.merge_gate_request`).
//
// Provenance (Fix 2 — no overclaim). The manifest supplies the CALLER-PROVIDED
// increment assertions (net opened/resolved counts, declared/actual ownership, the
// mutation observation, the hot-seam-serialized protocol assertion). It does NOT get
// the last word on receipts, coverage, or open security: the verb re-derives those
// from the real on-disk STORES — the receipt store, REQUIREMENTS.md vs the coverage
// baseline store, the findings store, and open SEC rows in .planning/BACKLOG.md —
// and UNIONS store findings with any manifest --findings. So an increment cannot
// make a real open security finding, a missing coverage advance, or an invalid
// receipt disappear by editing its manifest. Fail-closed strength is preserved
// end-to-end (an absent coverage baseline or a malformed store blocks).
//
// This is a PreToolUse hook, NOT a SessionStart bootstrap (DISC-02): it adds no
// SessionStart behavior, so check-single-mandate stays green.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Internal spawn timeout is deliberately BELOW the 15000ms timeout registered for
// this hook in hooks.json (Fix 5): the gate must finish and DELIVER its block within
// the harness's window, else the harness abandons the hook and the tool call is not
// blocked. 8000ms leaves ample headroom under the 15s registration.
const SPAWNOPT = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000, windowsHide: true };

/** Emit a block decision to stdout and exit 2 (the tool call is denied). */
function block(reason) {
  try {
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  } catch {
    /* stdout closed — the exit code alone still blocks the tool call */
  }
  process.exit(2);
}

// GitHub MCP tools that can merge/write to a protected branch WITHOUT a shell.
const MCP_MERGE_PR = 'mcp__com-github-github-mcp-server__merge_pull_request';
const MCP_PUSH_FILES = 'mcp__com-github-github-mcp-server__push_files';
const MCP_CREATE_OR_UPDATE = 'mcp__com-github-github-mcp-server__create_or_update_file';

/** A branch name that is protected (a merge into it must clear the gate). */
function isProtectedBranch(branch) {
  if (typeof branch !== 'string') return false;
  const b = branch.trim().replace(/^refs\/heads\//, '');
  return /^(main|master)$/i.test(b) || /^release\//i.test(b);
}

/**
 * Resolve the current branch of the repo at `cwd` and decide if it is protected.
 * Best-effort: a non-repo / git failure returns false (cannot confirm protected).
 * The RED-tested vector (bare/HEAD push while ON a protected branch) resolves here.
 */
function currentBranchIsProtected(cwd) {
  try {
    const r = spawnSync('git', ['-C', cwd || '.', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
    });
    if (r.status !== 0) return false;
    return isProtectedBranch(String(r.stdout || '').trim());
  } catch {
    return false;
  }
}

/**
 * A `git push` with no explicit branch ref (bare `git push`, `git push <remote>`, or
 * a `HEAD` push) pushes the CURRENT branch — so it is a protected-branch push exactly
 * when the current branch is protected. An explicit non-protected branch (e.g.
 * `git push origin feature/x`) is NOT a current-branch push.
 */
function isCurrentBranchPush(c) {
  const m = /\bgit\s+push\b(.*)$/is.exec(c);
  if (!m) return false;
  const rest = m[1] || '';
  if (/\bhead\b/i.test(rest)) return true; // explicit HEAD ref → current branch
  const positional = rest.trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
  return positional.length <= 1; // bare push or remote-only → current branch
}

/**
 * Extract a shell command string from a PreToolUse payload across runtimes.
 * Returns the command string if this is a shell tool call, else null (not shell).
 *
 * Handles:
 *   - Claude Code: tool_name 'Bash', tool_input.command is a string.
 *   - Codex / opencode / other AGENTS.md runtimes: tool_name 'shell'/'Shell'/
 *     'local_shell', command as a string OR an argv array (joined with spaces).
 * Case-insensitive on the tool name. A non-shell tool → null (falls through to
 * the MCP-tool classifier). Defensive: any odd shape → null (pass-through), never
 * throws — classification failures must not block ordinary work.
 */
function extractShellCommand(data) {
  if (!data || typeof data.tool_name !== 'string') return null;
  if (!/^(bash|shell|local_shell)$/i.test(data.tool_name.trim())) return null;
  const ti = data.tool_input;
  if (!ti || typeof ti !== 'object') {
    // Some runtimes put the command directly on the payload (data.command).
    return typeof data.command === 'string' ? data.command : null;
  }
  const raw = ti.command !== undefined ? ti.command : data.command;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string').join(' ');
  return null;
}

/**
 * Is `command` a merge / ship / release operation that must clear the merge gate?
 * Biased toward BLOCK for KNOWN vectors. `cwd` is used to resolve the current branch
 * for a bare/HEAD push. NOT exhaustive against arbitrary scripts (see HONEST SCOPE).
 */
function isMergeOp(command, cwd) {
  if (typeof command !== 'string' || command.trim() === '') return false;
  const c = command.toLowerCase();

  // `git merge <ref>` — but not the read-only `git merge-base`.
  if (/\bgit\s+merge\b/.test(c) && !/\bgit\s+merge-base\b/.test(c)) return true;

  // `gh pr merge ...`
  if (/\bgh\s+pr\s+merge\b/.test(c)) return true;

  // `git pull ...` — fetch + merge is a merge vector.
  if (/\bgit\s+pull\b/.test(c)) return true;

  // `git rebase ...` — integrates/rewrites history. Control-only ops are not a merge.
  if (/\bgit\s+rebase\b/.test(c)) {
    if (/--(abort|continue|skip|quit|edit-todo|show-current-patch)\b/.test(c)) return false;
    return true;
  }

  // `git push` to a protected branch or a release tag.
  if (/\bgit\s+push\b/.test(c)) {
    if (/--tags\b/.test(c)) return true; // release: push all tags
    if (/\brefs\/tags\//.test(c)) return true; // release: explicit tag ref
    if (/:\s*(refs\/heads\/)?(main|master)\b/.test(c)) return true; // HEAD:main refspec
    if (/\b(main|master)\b/.test(c)) return true; // push targeting main/master
    if (isCurrentBranchPush(c) && currentBranchIsProtected(cwd)) return true; // bare/HEAD on protected
  }

  return false;
}

/**
 * Is this a GitHub MCP tool call that merges / writes to a protected branch? These
 * are non-Bash tools; PreToolUse can match them, so the gate covers them too.
 */
function isMergeToolCall(toolName, toolInput) {
  if (toolName === MCP_MERGE_PR) return true; // a PR merge always clears the gate
  if (toolName === MCP_PUSH_FILES || toolName === MCP_CREATE_OR_UPDATE) {
    return isProtectedBranch(toolInput && toolInput.branch);
  }
  return false;
}

/**
 * Resolve the merge-gate evidence manifest path for a project. Default:
 * `.planning/strength/merge-gate-request.json`; relocatable via config
 * `strength.merge_gate_request`. Config read is best-effort and NEVER throws
 * (a missing/invalid config just yields the default path).
 */
function manifestPath(cwd) {
  const fallback = path.join(cwd, '.planning', 'strength', 'merge-gate-request.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8'));
    const rel = cfg && cfg.strength && cfg.strength.merge_gate_request;
    if (typeof rel === 'string' && rel !== '') return path.join(cwd, rel);
  } catch {
    /* no/invalid config → default path */
  }
  return fallback;
}

/**
 * Read the evidence manifest. Returns the parsed object, or null when the manifest
 * is absent (→ the caller blocks: missing evidence). THROWS on a malformed manifest
 * so the caller's catch fails closed.
 */
function readManifest(cwd) {
  let text;
  try {
    text = fs.readFileSync(manifestPath(cwd), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(text); // a malformed manifest throws → fail closed
}

/** Build the strength.merge-gate flag list from the evidence manifest. */
function buildMergeGateFlags(m) {
  const out = [];
  const csv = (v) => (Array.isArray(v) ? v.join(',') : v);
  const push = (flag, val) => {
    if (val !== undefined && val !== null) out.push(flag, String(val));
  };
  push('--increment', m.increment);
  push('--requirements', csv(m.requirements));
  push('--declared', csv(m.declared));
  push('--actual', csv(m.actual));
  push('--files', csv(m.files));
  push('--opened', m.opened);
  push('--resolved', m.resolved);
  push('--mutation-test', m.mutation_test);
  push('--mutation-flipped', m.mutation_flipped);
  // Fix 1: the seam-serialization protocol assertion for this increment. Only an
  // explicit `true` clears a seam-touching increment; anything else stays strict.
  if (m.hot_seam_serialized !== undefined) push('--hot-seam-serialized', m.hot_seam_serialized);
  if (m.findings !== undefined) push('--findings', typeof m.findings === 'string' ? m.findings : JSON.stringify(m.findings));
  if (m.items !== undefined) push('--items', typeof m.items === 'string' ? m.items : JSON.stringify(m.items));
  if (m.migration_number !== undefined) push('--migration-number', m.migration_number);
  return out;
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);

  // Stage 1: classify the tool call. Any parse/shape problem here is NOT a merge op,
  // so it must pass through (benign no-op) — never block ordinary work on a malformed
  // event. Both Bash merge commands AND the GitHub MCP merge/write tools are gated.
  let data;
  try {
    data = JSON.parse(input);
    const cwd = data.cwd || process.cwd();
    let isMerge = false;
    // Runtime-agnostic shell classification (REACH-CODEX-01): Claude names the
    // shell tool 'Bash' with a string `command`; Codex/opencode/other AGENTS.md
    // runtimes name it 'shell'/'Shell'/'local_shell' and may pass the command as
    // an array of argv. Extract the command string defensively so a merge run
    // through ANY of these tool shapes is gated, not just Claude's Bash.
    const shellCommand = extractShellCommand(data);
    if (shellCommand !== null) {
      isMerge = isMergeOp(shellCommand, cwd);
    } else {
      isMerge = isMergeToolCall(data.tool_name, data.tool_input);
    }
    if (!isMerge) process.exit(0); // ordinary tool call → no-op
  } catch {
    process.exit(0); // unclassifiable event → pass through
  }

  // Stage 2: it IS a merge/ship/release op. From here EVERY failure fails CLOSED.
  try {
    const cwd = data.cwd || process.cwd();

    // Scope guard: only ENFORCE in a project that opted into Ferrox strength-gating.
    // A globally-installed hook (e.g. Codex --global, coexisting with GSD) must NOT
    // police merges in unrelated projects — failing-closed a merge the project never
    // asked Ferrox to gate would break ordinary work (a GSD repo, any non-Ferrox
    // project). The opt-in marker is the `.planning/strength/` directory — the home
    // of receipts/coverage-baseline and the merge-gate evidence manifest. Absent →
    // this project is not Ferrox-strength-gated → pass through (exit 0). A real
    // Ferrox-gated project always has it (the manifest itself lives there), so this
    // never weakens enforcement where the gate is actually configured.
    if (!fs.existsSync(path.join(cwd, '.planning', 'strength'))) {
      process.exit(0);
    }

    // Resolve the merge-gate verb relative to THIS hook (works both in-repo and in
    // an installed plugin where ferrox-core/ is bundled beside hooks/). A missing
    // verb means we cannot evaluate the gate → block.
    const ferroxTools = path.resolve(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');
    if (!fs.existsSync(ferroxTools)) {
      block(`Merge-gate guard: cannot locate the merge-gate verb (ferrox-tools) at '${ferroxTools}'. Refusing to merge/ship/release without a strength gate — failing closed.`);
    }

    // The increment must have written its evidence manifest. No manifest → no
    // gathered evidence → block.
    const manifest = readManifest(cwd);
    if (manifest === null) {
      block(`Merge-gate guard: no merge-gate evidence manifest at '${manifestPath(cwd)}'. A merge/ship/release requires the increment's gathered evidence — failing closed. Write the manifest (increment, requirements, declared/actual/files, opened/resolved, mutation observation) before merging.`);
    }

    const flags = buildMergeGateFlags(manifest);
    const res = spawnSync(process.execPath, [ferroxTools, '--cwd', cwd, 'query', 'strength.merge-gate', ...flags, '--raw'], SPAWNOPT);

    if (res.error || typeof res.status !== 'number' || res.status !== 0) {
      const detail = res.error ? res.error.message : `exit ${res.status}`;
      block(`Merge-gate guard: strength.merge-gate did not complete cleanly (${detail}). An errored gate is never an allow — failing closed.`);
    }

    let verdict;
    try {
      verdict = JSON.parse(String(res.stdout || '').trim());
    } catch {
      block('Merge-gate guard: strength.merge-gate produced unparseable output; an un-verifiable gate is never an allow — failing closed.');
    }

    if (verdict && verdict.decision === 'pass') {
      process.exit(0); // evidence present and the gate passed → ALLOW the merge
    }

    const reasons = verdict && Array.isArray(verdict.reasons) && verdict.reasons.length
      ? verdict.reasons.join(', ')
      : `decision='${verdict && verdict.decision}'`;
    block(`Merge-gate guard: the strength merge-gate did not pass (${reasons}). This merge/ship/release is blocked until the gate returns pass.`);
  } catch (err) {
    // ANY thrown error while gating a merge op → BLOCK (fail closed). This is the
    // deliberate inversion of the worktree guard's "hook error → exit 0".
    block(`Merge-gate guard: error while evaluating the merge gate (${err && err.message}). Failing closed rather than allowing an un-gated merge.`);
  }
});
