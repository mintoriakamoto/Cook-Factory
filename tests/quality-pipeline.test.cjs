'use strict';

/**
 * QUAL-01 red-green tests — the language-keyed deterministic quality pipeline.
 *
 * The v1.7 benchmark showed the frontier's "quality edge" over the cheap-gated executor was mostly
 * cosmetic (a formatter closed ~64% of it for $0; objective lint/complexity/security/runtime came out
 * even). So Factory's polish is deterministic tooling (format->lint->security), not an LLM pass. These
 * cover: toolchain selection per language (fail-safe on unknown), the NON-REGRESSIVE keep gate, and the
 * verdict summary. PURE: no fs/env/clock/network. Never throws.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectToolchain, decideKeep, summarize } = require('../ferrox-core/bin/lib/quality-pipeline.cjs');

test('selectToolchain: python -> black + ruff + bandit', () => {
  const t = selectToolchain('python');
  assert.equal(t.known, true);
  assert.equal(t.formatter, 'black');
  assert.equal(t.linter, 'ruff');
  assert.equal(t.security, 'bandit');
});

test('selectToolchain: aliases resolve (py, ts, golang, rs)', () => {
  assert.equal(selectToolchain('py').formatter, 'black');
  assert.equal(selectToolchain('ts').formatter, 'prettier');
  assert.equal(selectToolchain('golang').formatter, 'gofmt');
  assert.equal(selectToolchain('rs').formatter, 'rustfmt');
});

test('selectToolchain: multi-language canonical formatters', () => {
  assert.equal(selectToolchain('javascript').formatter, 'prettier');
  assert.equal(selectToolchain('go').linter, 'govet');
  assert.equal(selectToolchain('rust').linter, 'clippy');
  assert.equal(selectToolchain('cpp').formatter, 'clang-format');
});

test('selectToolchain: unknown language -> known:false, run nothing (fail-safe)', () => {
  const t = selectToolchain('brainfuck');
  assert.equal(t.known, false);
  assert.equal(t.formatter, null);
  assert.equal(t.linter, null);
});

test('selectToolchain: garbage input never throws -> known:false', () => {
  for (const g of [undefined, null, 42, {}, '', '   ']) {
    const t = selectToolchain(g);
    assert.equal(t.known, false);
  }
});

test('selectToolchain: case/whitespace insensitive', () => {
  assert.equal(selectToolchain('  PYTHON  ').formatter, 'black');
});

test('decideKeep: non-regressive keep when after >= before', () => {
  assert.equal(decideKeep({ gateBefore: 29, gateAfter: 29 }).keep, true);
  assert.equal(decideKeep({ gateBefore: 29, gateAfter: 30 }).keep, true);
});

test('decideKeep: revert when polish regresses the gate', () => {
  const d = decideKeep({ gateBefore: 29, gateAfter: 28 });
  assert.equal(d.keep, false);
  assert.equal(d.reason, 'revert-regressed');
});

test('decideKeep: no after-score -> revert (fail-safe)', () => {
  assert.equal(decideKeep({ gateBefore: 29 }).keep, false);
  assert.equal(decideKeep({}).keep, false);
  assert.equal(decideKeep(undefined).keep, false);
});

test('decideKeep: no baseline -> keep only if after passes', () => {
  assert.equal(decideKeep({ gateAfter: 5 }).keep, true);
  assert.equal(decideKeep({ gateAfter: 0 }).keep, false);
});

test('summarize: clean when no lint or security issues', () => {
  const s = summarize({ formatChanged: true, lint: 0, security: { HIGH: 0, MEDIUM: 0, LOW: 0 } });
  assert.equal(s.clean, true);
  assert.equal(s.verdict, 'clean');
  assert.deepEqual(s.issues, []);
});

test('summarize: lint>0 and HIGH/MEDIUM security -> issues, surfaced', () => {
  const s = summarize({ lint: 3, security: { HIGH: 1, MEDIUM: 2, LOW: 5 } });
  assert.equal(s.clean, false);
  assert.equal(s.verdict, 'issues');
  assert.ok(s.issues.includes('lint:3'));
  assert.ok(s.issues.includes('security-high:1'));
  assert.ok(s.issues.includes('security-medium:2'));
  // LOW severity does not block
  assert.ok(!s.issues.some((i) => i.startsWith('security-low')));
});

test('summarize: lint unavailable (-1, tool error) -> unknown verdict', () => {
  const s = summarize({ lint: -1, security: {} });
  assert.equal(s.verdict, 'unknown');
  assert.ok(s.issues.includes('lint:unavailable'));
});

test('summarize: garbage never throws', () => {
  assert.doesNotThrow(() => summarize(undefined));
  assert.doesNotThrow(() => summarize({ lint: 'x', security: 'y' }));
});
