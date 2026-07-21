'use strict';

/**
 * PreToolUse merge-gate guard hook — fail-closed acceptance test (Plan 05-08, FF-B10).
 *
 * Drives hooks/ferrox-merge-gate-guard.js by piping a real PreToolUse event JSON on
 * stdin (never `node --check`), asserting the tool-layer verdict by EXIT CODE +
 * parsed stdout. This is the proof that the strength merge-gate is un-bypassable:
 *
 *   - a `git merge` (into main) with NO evidence exits 2 (BLOCK — fail closed);
 *   - the same merge with a seeded pass fixture exits 0 (ALLOW);
 *   - a non-merge Bash command (e.g. `ls`) exits 0 (benign pass-through);
 *   - a merge where the verb emits unparseable output exits 2 (fail closed);
 *   - a merge where the verb errors / the verb is missing exits 2 (fail closed);
 *   - after registration, scripts/check-single-mandate.cjs still exits 0 (the hook
 *     is PreToolUse-only, not a SessionStart bootstrap — DISC-02).
 *
 * The "pass" fixture reuses the exact evidence the Plan 07 merge-gate router reads:
 * a valid red-green receipt (seeded via the real `strength.receipt` verb) and an
 * advancing REQUIREMENTS.md, plus the increment-context evidence manifest the hook
 * forwards to the verb. The verb still verifies receipts/coverage against the real
 * on-disk stores, so the manifest cannot fake a pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'ferrox-merge-gate-guard.js');
const FERROX_TOOLS = path.join(ROOT, 'ferrox-core', 'bin', 'ferrox-tools.cjs');

// ─── fixtures ────────────────────────────────────────────────────────────────

/** Hermetic temp project carrying a real strength + coordination config block. */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-mgh-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(
      {
        strength: {
          receipt_store: '.planning/strength/receipts.json',
          coverage_store: '.planning/strength/coverage-baseline.json',
          requirements_path: '.planning/REQUIREMENTS.md',
          security_categories: ['security', 'auth', 'crypto', 'injection', 'secrets', 'deserialization'],
          medium_cluster_threshold: 3,
          security_age_limit_days: 7,
        },
        coordination: {
          hot_seams: ['**/*.lock', '**/migrations/**'],
          migration_store: '.planning/coord/migration-seq.json',
        },
      },
      null,
      2,
    ) + '\n',
  );
  // Mark this as a Ferrox strength-gated project so the guard enforces here (the
  // scope guard passes through projects with no `.planning/strength/`). Individual
  // "no evidence" tests still omit the manifest, so a missing manifest still blocks.
  fs.mkdirSync(path.join(dir, '.planning', 'strength'), { recursive: true });
  return dir;
}

/** Write the increment evidence manifest the hook forwards to the merge-gate verb. */
function seedManifest(dir, overrides) {
  const base = {
    increment: 'INC-1',
    requirements: ['STRONG-01'],
    declared: 'a.ts',
    actual: 'a.ts',
    files: 'src/foo.ts',
    opened: 0,
    resolved: 0,
    mutation_test: 'strong.test.cjs',
    mutation_flipped: true,
  };
  const manifest = Object.assign(base, overrides || {});
  fs.mkdirSync(path.join(dir, '.planning', 'strength'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'strength', 'merge-gate-request.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** Seed a REQUIREMENTS.md with `covered` of `total` requirement checkboxes marked. */
function seedRequirements(dir, covered, total) {
  const lines = ['# Requirements', ''];
  for (let i = 1; i <= total; i++) {
    const box = i <= covered ? 'x' : ' ';
    lines.push(`- [${box}] **STRONG-0${i}** requirement ${i}`);
  }
  fs.writeFileSync(path.join(dir, '.planning', 'REQUIREMENTS.md'), lines.join('\n') + '\n');
}

/** Seed the coverage baseline store (Fix 3: the baseline now fails closed). */
function seedCoverageBaseline(dir, covered) {
  fs.mkdirSync(path.join(dir, '.planning', 'strength'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'strength', 'coverage-baseline.json'),
    JSON.stringify({ covered }, null, 2) + '\n',
  );
}

/** Record a real red-green receipt for a requirement via the mutating verb. */
function seedReceipt(dir, requirement) {
  const res = spawnSync(
    process.execPath,
    [FERROX_TOOLS, '--cwd', dir, 'query', 'strength.receipt',
      '--requirement', requirement, '--test', 'strong-01.test.cjs',
      '--exit-code', '1', '--log-digest', 'abc123', '--commit', 'deadbeef', '--raw'],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0, `seedReceipt failed: ${res.stderr}`);
}

/** A PreToolUse Bash event JSON. */
function bashEvent(command, cwd) {
  return { tool_name: 'Bash', tool_input: { command }, cwd };
}

/** Pipe an event to a hook file on stdin; return { status, stdout, json }. */
function runHook(event, hookPath) {
  const res = spawnSync(process.execPath, [hookPath || HOOK], {
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
  let json;
  try {
    json = JSON.parse((res.stdout || '').trim());
  } catch {
    json = undefined;
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

/**
 * Stage a copy of the hook in a temp layout with a STUB ferrox-tools beside it, so
 * the hook (which resolves the verb relative to its own dir) invokes the stub. A
 * null `toolSource` omits the verb entirely (missing-binary case).
 */
function stageHookWithStubTool(toolSource) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-mgh-stub-'));
  fs.mkdirSync(path.join(rootDir, 'hooks'), { recursive: true });
  const hookPath = path.join(rootDir, 'hooks', 'ferrox-merge-gate-guard.js');
  fs.copyFileSync(HOOK, hookPath);
  if (toolSource !== null) {
    fs.mkdirSync(path.join(rootDir, 'ferrox-core', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'ferrox-core', 'bin', 'ferrox-tools.cjs'), toolSource);
  }
  return hookPath;
}

// ─── merge detection + pass-through ──────────────────────────────────────────

test('a non-merge Bash command passes through untouched (exit 0)', () => {
  const cwd = makeProject();
  for (const command of ['ls -la', 'git status', 'git commit -m wip', 'git push origin feature/foo']) {
    const r = runHook(bashEvent(command, cwd));
    assert.equal(r.status, 0, `'${command}' must pass through, got exit ${r.status} / ${r.stdout}`);
  }
});

test('a non-Bash tool call passes through untouched (exit 0)', () => {
  const cwd = makeProject();
  const r = runHook({ tool_name: 'Edit', tool_input: { file_path: '/x', old_string: 'a', new_string: 'b' }, cwd });
  assert.equal(r.status, 0, `non-Bash tool must pass through, got exit ${r.status}`);
});

test('merge/ship/release commands are all recognized and blocked when evidence is missing (exit 2)', () => {
  const cwd = makeProject();
  seedManifest(cwd); // manifest present, but NO receipt / REQUIREMENTS → verb blocks
  for (const command of ['git merge --no-ff release', 'gh pr merge 12 --squash', 'git push origin main', 'git push --tags']) {
    const r = runHook(bashEvent(command, cwd));
    assert.equal(r.status, 2, `'${command}' must be gated + blocked, got exit ${r.status} / ${r.stdout}`);
    assert.equal(r.json && r.json.decision, 'block', `'${command}' must emit a block decision`);
  }
});

// ─── BOTH directions against the REAL verb ───────────────────────────────────

test('a git merge with NO evidence manifest is BLOCKED (exit 2 — fail closed)', () => {
  const cwd = makeProject(); // no manifest at all
  const r = runHook(bashEvent('git merge --no-ff feature/x', cwd));
  assert.equal(r.status, 2, `missing manifest must fail closed, got exit ${r.status} / ${r.stdout}`);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /evidence manifest/i);
});

test('a git merge with a manifest but ABSENT stores is BLOCKED (exit 2 — fail closed)', () => {
  const cwd = makeProject();
  seedManifest(cwd); // manifest present; no receipt store, no REQUIREMENTS.md
  const r = runHook(bashEvent('git merge --no-ff feature/x', cwd));
  assert.equal(r.status, 2, `absent stores must fail closed, got exit ${r.status} / ${r.stdout}`);
  assert.equal(r.json.decision, 'block');
});

test('a git merge with a seeded PASS fixture is ALLOWED (exit 0)', () => {
  const cwd = makeProject();
  seedManifest(cwd);
  seedReceipt(cwd, 'STRONG-01'); // valid red-green receipt
  seedRequirements(cwd, 1, 2); // covered 1 > baseline 0 → landed
  seedCoverageBaseline(cwd, 0); // Fix 3: baseline fails closed — must be seeded
  const r = runHook(bashEvent('git merge --no-ff feature/x', cwd));
  assert.equal(r.status, 0, `a fully-satisfying fixture must be allowed, got exit ${r.status} / ${r.stdout} / ${r.stderr}`);
  assert.equal(r.stdout.trim(), '', 'an allowed merge emits no block decision');
});

// ─── fail-closed branches via a stub verb ────────────────────────────────────

test('a merge where the verb emits UNPARSEABLE output is BLOCKED (exit 2)', () => {
  const cwd = makeProject();
  seedManifest(cwd);
  // Stub verb: exit 0 but print non-JSON garbage.
  const hookPath = stageHookWithStubTool('process.stdout.write("this is not json\\n");process.exit(0);\n');
  const r = runHook(bashEvent('git merge --no-ff feature/x', cwd), hookPath);
  assert.equal(r.status, 2, `unparseable verb output must fail closed, got exit ${r.status} / ${r.stdout}`);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /unparseable/i);
});

test('a merge where the verb EXITS NON-ZERO is BLOCKED (exit 2)', () => {
  const cwd = makeProject();
  seedManifest(cwd);
  const hookPath = stageHookWithStubTool('process.stderr.write("boom\\n");process.exit(3);\n');
  const r = runHook(bashEvent('git merge --no-ff feature/x', cwd), hookPath);
  assert.equal(r.status, 2, `a non-zero verb exit must fail closed, got exit ${r.status} / ${r.stdout}`);
  assert.equal(r.json.decision, 'block');
});

test('a merge where the verb THROWS while gating is BLOCKED (exit 2)', () => {
  const cwd = makeProject();
  seedManifest(cwd);
  const hookPath = stageHookWithStubTool('throw new Error("gate exploded");\n');
  const r = runHook(bashEvent('git merge --no-ff feature/x', cwd), hookPath);
  assert.equal(r.status, 2, `a throwing verb must fail closed, got exit ${r.status} / ${r.stdout}`);
  assert.equal(r.json.decision, 'block');
});

test('a merge where the gating verb is MISSING is BLOCKED (exit 2 — fail closed)', () => {
  const cwd = makeProject();
  seedManifest(cwd);
  const hookPath = stageHookWithStubTool(null); // no ferrox-tools beside the hook
  const r = runHook(bashEvent('git merge --no-ff feature/x', cwd), hookPath);
  assert.equal(r.status, 2, `a missing gate verb must fail closed, got exit ${r.status} / ${r.stdout}`);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /cannot locate the merge-gate verb/i);
});

test('the ALLOW path is not vacuous: a stub verb returning pass yields exit 0', () => {
  const cwd = makeProject();
  seedManifest(cwd);
  const hookPath = stageHookWithStubTool('process.stdout.write(JSON.stringify({decision:"pass",reasons:[]}));process.exit(0);\n');
  const r = runHook(bashEvent('git merge --no-ff feature/x', cwd), hookPath);
  assert.equal(r.status, 0, `a passing gate must allow the merge, got exit ${r.status} / ${r.stdout}`);
  assert.equal(r.stdout.trim(), '');
});

// ─── Fix 4a: broadened merge-vector coverage (pull / rebase / bare push / MCP) ──

/** A real git repo on branch main, for the bare/HEAD-push-on-protected vector. */
function makeGitRepoOnMain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-mgh-git-'));
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['init', '-q']);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  // Ferrox strength-gated marker so the scope guard enforces here (no manifest -> block).
  fs.mkdirSync(path.join(dir, '.planning', 'strength'), { recursive: true });
  return dir;
}

/** An MCP PreToolUse event JSON. */
function mcpEvent(toolName, toolInput, cwd) {
  return { tool_name: toolName, tool_input: toolInput || {}, cwd };
}

test('git pull origin main is a merge vector and is BLOCKED with no evidence (exit 2)', () => {
  const cwd = makeProject();
  const r = runHook(bashEvent('git pull origin main', cwd));
  assert.equal(r.status, 2, `git pull must be gated, got exit ${r.status} / ${r.stdout}`);
  assert.equal(r.json && r.json.decision, 'block');
});

test('git rebase main is a merge vector and is BLOCKED with no evidence (exit 2)', () => {
  const cwd = makeProject();
  const r = runHook(bashEvent('git rebase main', cwd));
  assert.equal(r.status, 2, `git rebase must be gated, got exit ${r.status} / ${r.stdout}`);
  assert.equal(r.json && r.json.decision, 'block');
});

test('git rebase --abort is a control op and passes through (exit 0)', () => {
  const cwd = makeProject();
  const r = runHook(bashEvent('git rebase --abort', cwd));
  assert.equal(r.status, 0, `a rebase control op must pass through, got exit ${r.status} / ${r.stdout}`);
});

test('a bare `git push` while ON a protected branch is BLOCKED (exit 2)', () => {
  const cwd = makeGitRepoOnMain();
  for (const command of ['git push', 'git push origin', 'git push origin HEAD', 'git push -u origin HEAD:main']) {
    const r = runHook(bashEvent(command, cwd));
    assert.equal(r.status, 2, `'${command}' on main must be gated, got exit ${r.status} / ${r.stdout}`);
    assert.equal(r.json && r.json.decision, 'block');
  }
});

test('an MCP merge_pull_request tool call is BLOCKED with no evidence (exit 2)', () => {
  const cwd = makeProject();
  const r = runHook(mcpEvent('mcp__com-github-github-mcp-server__merge_pull_request', { owner: 'o', repo: 'r', pullNumber: 3 }, cwd));
  assert.equal(r.status, 2, `MCP merge_pull_request must be gated, got exit ${r.status} / ${r.stdout}`);
  assert.equal(r.json && r.json.decision, 'block');
});

test('an MCP create_or_update_file / push_files to a PROTECTED branch is BLOCKED (exit 2)', () => {
  const cwd = makeProject();
  for (const tool of ['mcp__com-github-github-mcp-server__push_files', 'mcp__com-github-github-mcp-server__create_or_update_file']) {
    const r = runHook(mcpEvent(tool, { branch: 'main', message: 'x' }, cwd));
    assert.equal(r.status, 2, `${tool}->main must be gated, got exit ${r.status} / ${r.stdout}`);
    assert.equal(r.json && r.json.decision, 'block');
  }
});

test('an MCP write to a NON-protected branch passes through (exit 0)', () => {
  const cwd = makeProject();
  const r = runHook(mcpEvent('mcp__com-github-github-mcp-server__push_files', { branch: 'feature/x', message: 'x' }, cwd));
  assert.equal(r.status, 0, `a feature-branch MCP write must pass through, got exit ${r.status} / ${r.stdout}`);
});

// ─── Fix 5b: internal spawn timeout is below the registered hooks.json timeout ──

test('the hook internal spawn timeout is strictly below the registered hooks.json timeout', () => {
  const hookSrc = fs.readFileSync(HOOK, 'utf8');
  const m = /timeout:\s*(\d+)/.exec(hookSrc); // first is the merge-gate spawn timeout
  assert.ok(m, 'the hook must set an internal spawn timeout');
  const internalMs = Number(m[1]);
  const hooksJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const entry = hooksJson.hooks.PreToolUse
    .flatMap((e) => (Array.isArray(e.hooks) ? e.hooks : []))
    .find((h) => (h.command || '').includes('ferrox-merge-gate-guard.js'));
  const registeredMs = Number(entry.timeout) * 1000; // hooks.json timeout is in seconds
  assert.ok(
    internalMs < registeredMs,
    `internal spawn timeout (${internalMs}ms) must be below the registered hook timeout (${registeredMs}ms) so the block is delivered before the harness abandons the hook`,
  );
});

// ─── DISC-02: no SessionStart bootstrap re-introduced ────────────────────────

test('check-single-mandate still passes after the PreToolUse hook is registered (exit 0)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-single-mandate.cjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `check-single-mandate must stay green (PreToolUse hook is not a SessionStart bootstrap): ${r.stderr}`);
  assert.match(r.stdout, /check-single-mandate: PASS/);
});
