'use strict';

/**
 * BOUNDED live demo for the Phase-6 external-cli seam (Plan 08) — the `.slow`
 * marker keeps it OUT of the default unit suite (run via `npm run test:slow`).
 *
 * This is the honest "real-but-environment-dependent" half of the split (see
 * model-tiering.md, Mechanism vs Protocol). It invokes the REAL codex/gemini
 * (Trident) and REAL rtk ONCE each through the Plan 06 `--live` seam and asserts a
 * single bounded pass — BUT it self-gates on CLI presence and must NEVER fail
 * because a CLI is absent (it is NOT a CI hard-dependency, T-06-17). Every spawn is
 * timeout-bounded.
 *
 *   Case A (Trident): one `trident.audit --live` pass at high-risk-wave-audit with
 *   caller-family claude. Present → a SINGLE-PASS complete (pass:'single',
 *   bounded:true) whose panel_families never include claude (cross-lineage), and
 *   exactly ONE decision object (one bounded pass, no loop — T-06-06). Absent → the
 *   graceful { decision:'degraded' } shape at exit 0, no throw.
 *
 *   Case B (rtk): one `rtk.report --live`. Present → a parsed { source:'rtk' }
 *   savings figure echoed from rtk's own output. Absent → the graceful
 *   { saved:0, source:'rtk', error:'empty' } shape at exit 0, no throw.
 *
 * Both cases pass on EITHER branch — presence proves the real wiring, absence proves
 * graceful degradation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');
const SPAWN_TIMEOUT_MS = 60000;

/** Create a hermetic temp project dir with a real model block (the two checkpoints + rtk). */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-live-demo-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(
      {
        model: {
          trident_checkpoints: ['plan-lock-gap-audit', 'high-risk-wave-audit'],
          rtk: { enabled: true },
        },
      },
      null,
      2,
    ) + '\n',
  );
  return dir;
}

/**
 * Self-gate: is an external CLI present? Uses the SAME `--version` probe shape the
 * seam uses, timeout-bounded. A spawn error (ENOENT) or null status → absent.
 */
function cliPresent(bin) {
  const res = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
  return res.error === undefined && res.status !== null;
}

/** Spawn a ferrox-tools --live query; return { status, json, stdout, stderr }. */
function runLive(cwd, verb, flags) {
  const res = spawnSync(
    process.execPath,
    [FERROX_TOOLS, '--cwd', cwd, 'query', verb, ...flags, '--raw'],
    { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS },
  );
  let json;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = undefined;
  }
  return { status: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

// ─── Case A: real codex+gemini Trident — a single bounded cross-lineage pass ──────

test('Case A: trident.audit --live is a single bounded pass excluding the caller family (or degrades gracefully)', () => {
  const cwd = makeProject();
  const r = runLive(cwd, 'trident.audit', [
    '--live', '--caller-family', 'claude', '--checkpoint', 'high-risk-wave-audit',
  ]);

  // NEVER a hard dependency: exit 0 and a single parseable decision object on either branch.
  assert.equal(r.status, 0, `live trident must exit 0 (stderr: ${r.stderr})`);
  assert.ok(r.json && typeof r.json === 'object' && !Array.isArray(r.json),
    'live trident must emit exactly ONE decision object (one bounded pass, not a loop)');

  const bothPresent = cliPresent('codex') && cliPresent('gemini');
  if (bothPresent) {
    // Real panel wired: a single bounded cross-lineage pass.
    assert.equal(r.json.decision, 'complete', 'present codex+gemini → a completed bounded audit');
    assert.equal(r.json.pass, 'single', 'exactly one bounded pass — never a loop');
    assert.equal(r.json.bounded, true, 'the pass is marked bounded');
    assert.equal(r.json.checkpoint, 'high-risk-wave-audit');
    assert.ok(Array.isArray(r.json.panel_families), 'panel_families is a list');
    assert.ok(!r.json.panel_families.includes('claude'),
      'cross-lineage: the caller family (claude) is NEVER in the real panel (T-06-07)');
    assert.ok(r.json.panel_families.length >= 1, 'the real panel drew at least one external family');
  } else {
    // Graceful degradation: no throw, no loop, an explicit degraded verdict.
    assert.equal(r.json.decision, 'degraded', 'absent codex/gemini → a graceful degraded verdict');
    assert.equal(r.json.reason, 'cli-absent', 'the degrade names the absent CLI cause');
    assert.ok(typeof r.json.cli === 'string' && r.json.cli.length > 0, 'the absent CLI is named');
  }
});

// ─── Case B: real rtk savings — parsed from rtk's own output, or graceful ─────────

test('Case B: rtk.report --live parses rtk\'s own savings figure (or degrades gracefully)', () => {
  const cwd = makeProject();
  const r = runLive(cwd, 'rtk.report', ['--live']);

  // NEVER a hard dependency: exit 0 and a parseable object on either branch.
  assert.equal(r.status, 0, `live rtk.report must exit 0 (stderr: ${r.stderr})`);
  assert.ok(r.json && typeof r.json === 'object', 'live rtk.report must emit a decision object');
  assert.equal(r.json.source, 'rtk', 'the figure is always sourced from rtk, never fabricated');

  if (cliPresent('rtk')) {
    // Real rtk wired: a finite, non-negative saved figure echoed from rtk gain.
    assert.equal(typeof r.json.saved, 'number', 'present rtk → a numeric saved figure');
    assert.ok(Number.isFinite(r.json.saved) && r.json.saved >= 0,
      'the saved figure is a real, non-negative number parsed from rtk output');
  } else {
    // Graceful degradation: empty rtk output → saved 0 + an error token, no throw.
    assert.equal(r.json.saved, 0, 'absent rtk → saved 0 (never fabricated)');
    assert.equal(r.json.error, 'empty', 'the degrade tags the empty-output cause');
  }
});
