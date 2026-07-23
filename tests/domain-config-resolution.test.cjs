'use strict';

/**
 * MILESTONE v1.12 Wave 0.1 — `domain` as a registered config key.
 *
 * The domain fact is classified once and stored in .planning/config.json;
 * gate-select stays PURE and call sites read the config fact and pass it into
 * selectGate(). This test guards the 2 seams that make the key real:
 *
 *  1. Resolution: loadConfig propagates `domain` (not schema-registered-but-
 *     dropped — the exact MODEL-01..05 trap model-config-resolution guards).
 *     Absent domain resolves to null (unset default).
 *  2. CLI round-trip: config-set accepts the 20 canonical gate-select domains
 *     PLUS their registered aliases (aliases resolve on read the way
 *     gate-select normalizes); rejects anything unknown (`book` is a TEMPLATE,
 *     never a domain — ADR-ARTIFACT-TEMPLATE-FIELD.md); `null` unsets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadConfig } = require('../ferrox-core/bin/lib/config-loader.cjs');
const { selectGate, listGateDomains } = require('../ferrox-core/bin/lib/gate-select.cjs');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

function makeProject(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-domain-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(config ?? {}, null, 2) + '\n',
  );
  return dir;
}

function runTools(cwd, args) {
  const res = spawnSync(process.execPath, [FERROX_TOOLS, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// ─── Resolution seam ─────────────────────────────────────────────────────────

test('loadConfig propagates a configured domain verbatim', () => {
  const cwd = makeProject({ domain: 'writing' });
  const cfg = loadConfig(cwd);
  assert.equal(cfg.domain, 'writing', 'domain must be resolved, not dropped');
});

test('no domain in config resolves to null (unset default)', () => {
  const cwd = makeProject({});
  const cfg = loadConfig(cwd);
  assert.equal(cfg.domain, null, 'unset domain resolves to the manifest null default');
});

test('an alias domain survives resolution and normalizes at the gate-select read seam', () => {
  const cwd = makeProject({ domain: 'frontend' });
  const cfg = loadConfig(cwd);
  assert.equal(cfg.domain, 'frontend', 'the stored alias survives resolution as written');
  const sel = selectGate(cfg.domain);
  assert.equal(sel.known, true, 'gate-select resolves the alias on read');
  assert.equal(sel.tier, 1, 'frontend collapses to the web-ui tier-1 row');
});

// ─── CLI round-trip seam ─────────────────────────────────────────────────────

test('config-set domain accepts every canonical gate-select domain', () => {
  const cwd = makeProject({});
  for (const domain of listGateDomains()) {
    const set = runTools(cwd, ['config-set', 'domain', domain]);
    assert.equal(set.status, 0, `config-set domain ${domain} must succeed: ${set.stderr}`);
  }
  const get = runTools(cwd, ['config-get', 'domain', '--raw']);
  assert.equal(get.status, 0);
  const domains = listGateDomains();
  assert.equal(get.stdout.trim(), domains[domains.length - 1]);
});

test('config-set domain accepts a registered alias and round-trips it', () => {
  const cwd = makeProject({});
  const set = runTools(cwd, ['config-set', 'domain', 'frontend']);
  assert.equal(set.status, 0, `alias must be accepted: ${set.stderr}`);
  const get = runTools(cwd, ['config-get', 'domain', '--raw']);
  assert.equal(get.status, 0);
  assert.equal(get.stdout.trim(), 'frontend', 'alias stored as written; read seam normalizes');
});

test('config-set domain rejects unknown values (book is a template, not a domain)', () => {
  const cwd = makeProject({});
  for (const bad of ['book', 'campaign', 'software', 'not-a-domain']) {
    const set = runTools(cwd, ['config-set', 'domain', bad]);
    assert.notEqual(set.status, 0, `config-set domain ${bad} must be rejected`);
    assert.match(set.stderr + set.stdout, /Invalid domain/, 'rejection names the key');
  }
  // A rejected set must not have written anything.
  const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf-8'));
  assert.equal(cfg.domain, undefined, 'rejected values never reach disk');
});

test('config-set domain null unsets the key (documented clear path)', () => {
  const cwd = makeProject({ domain: 'writing' });
  const set = runTools(cwd, ['config-set', 'domain', 'null']);
  assert.equal(set.status, 0, `unset must succeed: ${set.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf-8'));
  assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'domain'), false, 'null deletes the key');
});
