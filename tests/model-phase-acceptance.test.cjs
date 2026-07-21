'use strict';

/**
 * Phase 6 acceptance test (Plan 08) — proves MODEL-01..05 end-to-end over the
 * SPAWNED ferrox-tools CLI on INJECTED inputs (the deterministic, enforceable half
 * of the honest split; the real codex/gemini/rtk wiring is the separate `.slow`
 * live demo). One hard assert per MODEL requirement, all inputs EXPLICIT so every
 * decision is deterministic.
 *
 *   MODEL-01 model.route      — stage→tier map, inspectable via --dump.
 *   MODEL-02 model.escalate   — the one-hop cap (attempt 1 escalates, attempt 2 refused).
 *   MODEL-03 model.risk-grade — a risk-boundary path forces high-risk (frontier+Trident)
 *                               regardless of a low self-grade, case-insensitively.
 *   MODEL-04 trident.audit    — bounded cross-lineage single pass; open-ended refused;
 *                               unknown checkpoint refused; caller-in-panel refused.
 *   MODEL-05 rtk.wrap/report  — wrap when enabled+present, passthrough when off/absent;
 *                               report parses a canned savings figure.
 *
 * Then the DISC-02 / generated-sync floor is asserted by shelling
 * check-single-mandate + gen-inventory-manifest --check (exit 0 — no new invoke-first
 * SessionStart, no inventory drift). node --test exits non-zero on any failure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FERROX_TOOLS = path.join(ROOT, 'ferrox-core', 'bin', 'ferrox-tools.cjs');

/** Create a hermetic temp project dir with a full, explicit model config block. */
function makeProject(rtkEnabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-model-accept-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(
      {
        model: {
          stage_tiers: {
            verify: 'frontier',
            audit: 'frontier',
            judgment: 'frontier',
            build: 'mid',
            execute: 'mid',
            grunt: 'small',
          },
          default_tier: 'mid',
          tier_order: ['small', 'mid', 'frontier'],
          max_escalations: 1,
          risk_boundaries: ['auth', 'crypto', 'payments', 'pii', 'deserialization', 'network-file'],
          trident_checkpoints: ['plan-lock-gap-audit', 'high-risk-wave-audit'],
          rtk: { enabled: rtkEnabled },
        },
      },
      null,
      2,
    ) + '\n',
  );
  return dir;
}

/** Spawn a ferrox-tools query verb in a hermetic cwd; return { status, json, stderr }. */
function runVerb(cwd, verb, flags) {
  const res = spawnSync(
    process.execPath,
    [FERROX_TOOLS, '--cwd', cwd, 'query', verb, ...flags, '--raw'],
    { encoding: 'utf8' },
  );
  let json;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = undefined;
  }
  return { status: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

// ─── MODEL-01: model.route — stage→tier + inspectable --dump ──────────────────────

test('MODEL-01: model.route maps each Build-Line stage to its tier and --dump is inspectable', () => {
  const cwd = makeProject();
  const verify = runVerb(cwd, 'model.route', ['--stage', 'verify']);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(verify.json.tier, 'frontier', 'a judgment/verify/audit stage → frontier');

  assert.equal(runVerb(cwd, 'model.route', ['--stage', 'build']).json.tier, 'mid', 'build → mid');
  assert.equal(runVerb(cwd, 'model.route', ['--stage', 'grunt']).json.tier, 'small', 'grunt → small');

  const dump = runVerb(cwd, 'model.route', ['--dump']);
  assert.equal(dump.status, 0, dump.stderr);
  assert.ok(dump.json.map && typeof dump.json.map === 'object', '--dump returns the inspectable stage→tier map');
  assert.equal(dump.json.map.verify, 'frontier');
  assert.equal(dump.json.map.grunt, 'small');
});

// ─── MODEL-02: model.escalate — the one-hop cap ───────────────────────────────────

test('MODEL-02: model.escalate allows one hop then refuses the second (the cap)', () => {
  const cwd = makeProject();
  const first = runVerb(cwd, 'model.escalate', ['--from', 'small', '--attempt', '1']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.decision, 'escalate', 'the first escalation is allowed');
  assert.equal(first.json.tier, 'mid', 'small escalates exactly one hop → mid');

  const second = runVerb(cwd, 'model.escalate', ['--from', 'small', '--attempt', '2']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.decision, 'refused', 'a second escalation attempt is refused (anti-runaway-cost)');
});

// ─── MODEL-03: model.risk-grade — a boundary forces high-risk regardless of self-grade ──

test('MODEL-03: model.risk-grade forces high-risk (frontier+Trident) on a boundary path, case-insensitively, overriding a low self-grade', () => {
  const cwd = makeProject();
  // Uppercased path proves case-insensitive boundary matching (Phase-4 lesson).
  const risky = runVerb(cwd, 'model.risk-grade', ['--paths', 'SRC/AUTH/Login.ts', '--self-grade', 'low']);
  assert.equal(risky.status, 0, risky.stderr);
  assert.equal(risky.json.grade, 'high-risk', 'an auth-boundary path forces high-risk even with a low self-grade');
  assert.equal(risky.json.forcesFrontier, true, 'high-risk forces the frontier tier');
  assert.equal(risky.json.forcesTrident, true, 'high-risk forces a Trident audit');
  assert.ok(risky.json.matched.includes('auth'), 'the matched boundary token is reported');

  const benign = runVerb(cwd, 'model.risk-grade', ['--paths', 'src/util/format.ts', '--self-grade', 'low']);
  assert.equal(benign.json.grade, 'low', 'a benign path returns the self-grade');
  assert.equal(benign.json.forcesFrontier, false, 'a benign path forces nothing');
});

// ─── MODEL-04: trident.audit — bounded, cross-lineage, anti-loop ──────────────────

test('MODEL-04: trident.audit is a bounded cross-lineage single pass tagging consensus vs contested', () => {
  const cwd = makeProject();
  const panel = JSON.stringify([
    { family: 'codex', findings: ['missing-authz', 'weak-hash'] },
    { family: 'gemini', findings: ['missing-authz'] },
  ]);
  const r = runVerb(cwd, 'trident.audit', ['--caller-family', 'claude', '--checkpoint', 'high-risk-wave-audit', '--panel', panel]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'complete');
  assert.equal(r.json.pass, 'single', 'a single bounded pass — no loop');
  assert.equal(r.json.bounded, true);
  assert.ok(!r.json.panel_families.includes('claude'), 'the caller family is excluded (cross-lineage)');
  assert.ok(r.json.consensus.includes('missing-authz'), 'a two-family finding is consensus');
  assert.ok(r.json.contested.includes('weak-hash'), 'a single-family finding is contested');
});

test('MODEL-04: trident.audit refuses the three unbounded / illegal invocations', () => {
  const cwd = makeProject();
  const base = ['--caller-family', 'claude', '--checkpoint', 'high-risk-wave-audit', '--panel', '[]'];

  const openEnded = runVerb(cwd, 'trident.audit', [...base, '--open-ended']);
  assert.equal(openEnded.json.decision, 'refused');
  assert.equal(openEnded.json.reason, 'unbounded-invocation', 'an --open-ended invocation is refused (the anti-loop bound)');

  const badCheckpoint = runVerb(cwd, 'trident.audit', ['--caller-family', 'claude', '--checkpoint', 'third-audit', '--panel', '[]']);
  assert.equal(badCheckpoint.json.decision, 'refused');
  assert.equal(badCheckpoint.json.reason, 'invalid-checkpoint', 'a third/unknown checkpoint is refused');

  const callerInPanel = JSON.stringify([{ family: 'claude', findings: ['x'] }, { family: 'gemini', findings: ['y'] }]);
  const selfAudit = runVerb(cwd, 'trident.audit', ['--caller-family', 'claude', '--checkpoint', 'high-risk-wave-audit', '--panel', callerInPanel]);
  assert.equal(selfAudit.json.decision, 'refused');
  assert.equal(selfAudit.json.reason, 'caller-family-in-panel', 'a panel containing the caller family is refused');
});

// ─── MODEL-05: rtk.wrap / rtk.report — wrap/passthrough + honest savings parse ─────

test('MODEL-05: rtk.wrap wraps when enabled+present and passes through when off/absent; rtk.report parses the savings', () => {
  const enabled = makeProject(true);
  const wrap = runVerb(enabled, 'rtk.wrap', ['--command', 'git,status', '--rtk-present', 'true']);
  assert.equal(wrap.status, 0, wrap.stderr);
  assert.equal(wrap.json.decision, 'wrap');
  assert.deepEqual(wrap.json.wrapped, ['rtk', 'git', 'status']);

  const absent = runVerb(enabled, 'rtk.wrap', ['--command', 'git,status', '--rtk-present', 'false']);
  assert.equal(absent.json.decision, 'passthrough', 'rtk absent → graceful passthrough');
  assert.deepEqual(absent.json.wrapped, ['git', 'status'], 'the original command is unchanged');

  const disabled = makeProject(false);
  const off = runVerb(disabled, 'rtk.wrap', ['--command', 'git,status', '--rtk-present', 'true']);
  assert.equal(off.json.decision, 'passthrough', 'the flag off never wraps even with rtk present');

  const report = runVerb(enabled, 'rtk.report', ['--rtk-output', 'Tokens saved: 45,231 (73% reduction)']);
  assert.equal(report.status, 0, report.stderr);
  assert.equal(report.json.saved, 45231);
  assert.equal(report.json.pct, 73);
  assert.equal(report.json.source, 'rtk', 'the figure is echoed from rtk, never fabricated');
});

// ─── DISC-02 / generated-sync floor — no new SessionStart, no inventory drift ──────

test('the DISC-02 / generated-sync floor holds: check-single-mandate + inventory --check exit 0', () => {
  const mandate = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-single-mandate.cjs')], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(mandate.status, 0, `check-single-mandate must pass (no new invoke-first SessionStart)\n${mandate.stdout}\n${mandate.stderr}`);

  const inventory = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-inventory-manifest.cjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(inventory.status, 0, `gen-inventory-manifest --check must pass (no inventory drift)\n${inventory.stdout}\n${inventory.stderr}`);
});
