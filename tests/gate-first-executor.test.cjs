'use strict';

/**
 * UGE-05 red-green tests — the native gate-first climb driver.
 *
 * runGateFirst drives the PURE gate-climb state machine (UGE-04) with injected effects
 * (generate / writeArtifact / runGate / now / optional polish) — so every test here runs
 * with stubs: no network, no subprocess, no clock dependence.
 *
 * Under test:
 *   - probe green-first-call -> done (dominant cost saver), roundsUsed 1;
 *   - artifact extraction: the LAST fenced block of the model reply, fences stripped;
 *   - ensemble on probe failure (sequential), ratchet keeps the best;
 *   - surgical climb + per-check escalation (escalated flag) + single consolidation;
 *   - TRUST BOUNDARY: prompts carry ONLY check identifier strings from fails[] — never
 *     gate source, never expected values (dedicated tests, incl. builder-level);
 *   - a generate throw/timeout yields no candidate but never crashes the run;
 *   - per-call timeout forwarded to EVERY generate call;
 *   - post-green QUAL-01 polish hook: non-regressive keep via decideKeep, still-green only;
 *   - stop reasons surfaced verbatim; result shape {solved, score, fails, roundsUsed,
 *     escalated, stopReason, finalText, log, costUsd};
 *   - createDefaultEffects: thin adapter over the openai-client chat surface + gate-runner,
 *     fully stub-injected (no network).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runGateFirst,
  createDefaultEffects,
  extractArtifact,
  buildProbePrompt,
  buildSurgicalPrompt,
  buildConsolidationPrompt,
} = require('../ferrox-core/bin/lib/gate-first-executor.cjs');

/** Wrap code in a single fenced block the way a well-behaved builder model replies. */
function fenced(code) {
  return 'Here is the artifact:\n```python\n' + code + '\n```\n';
}

/** Effects harness: generate/gate are per-test functions; every call is recorded. */
function makeEffects({ generate, gate, polish } = {}) {
  const seen = { generate: [], gated: [], writes: [], polishes: 0 };
  const effects = {
    generate: async (args) => {
      seen.generate.push(args);
      return generate(args, seen.generate.length);
    },
    writeArtifact: (text) => {
      seen.writes.push(text);
      return `/scratch/artifact-${seen.writes.length}.py`;
    },
    runGate: ({ text }) => {
      seen.gated.push(text);
      return gate(text);
    },
    now: () => 42,
  };
  if (polish) {
    effects.polish = (text) => {
      seen.polishes += 1;
      return polish(text);
    };
  }
  return { effects, seen };
}

const SPEC = 'Build a CSV parser that round-trips quoted fields.';
const CONFIG = { cheap: ['c1', 'c2', 'c3'], ladder: ['big1'], budget: 12, seedN: 3, perCallTimeoutMs: 5000 };

// ---------- artifact extraction (pure) ----------

test('extractArtifact: takes the LAST fenced block, fences stripped', () => {
  const reply = 'Plan first:\n```\ndraft one\n```\nBut actually:\n```python\nfinal = True\n```\ntrailing prose';
  assert.equal(extractArtifact(reply), 'final = True');
});

test('extractArtifact: no fenced block -> the whole reply, trimmed', () => {
  assert.equal(extractArtifact('  bare artifact text \n'), 'bare artifact text');
});

test('extractArtifact: garbage input -> empty string, never throws', () => {
  for (const g of [undefined, null, 42, {}, []]) assert.equal(extractArtifact(g), '');
});

// ---------- prompt builders: trust boundary at the source ----------

test('buildProbePrompt: spec verbatim + emit-only-the-artifact instruction', () => {
  const p = buildProbePrompt(SPEC);
  assert.ok(p.includes(SPEC));
  assert.match(p, /ONLY the complete artifact/i);
  assert.match(p, /single fenced/i);
});

test('buildSurgicalPrompt: spec + best text + target fail + up to 8 others + fix-without-regressing', () => {
  const others = Array.from({ length: 12 }, (_, i) => `other_check_${i}`);
  const p = buildSurgicalPrompt(SPEC, 'best-so-far-code', 'target_check', others);
  assert.ok(p.includes(SPEC));
  assert.ok(p.includes('best-so-far-code'));
  assert.match(p, /this check FAILS: target_check/i);
  for (const o of others.slice(0, 8)) assert.ok(p.includes(o), `includes ${o}`);
  for (const o of others.slice(8)) assert.ok(!p.includes(o), `excludes ${o} (cap 8)`);
  assert.match(p, /without regressing/i);
});

test('buildConsolidationPrompt: spec + fix-ALL instruction + first 10 fails', () => {
  const fails = Array.from({ length: 14 }, (_, i) => `broken_${String(i).padStart(2, '0')}`);
  const p = buildConsolidationPrompt(SPEC, fails);
  assert.ok(p.includes(SPEC));
  assert.match(p, /FAILS these checks/i);
  assert.match(p, /fix ALL/i);
  for (const f of fails.slice(0, 10)) assert.ok(p.includes(f));
  for (const f of fails.slice(10)) assert.ok(!p.includes(f), `first 10 only: ${f}`);
});

test('TRUST BOUNDARY: prompts built from a fails list contain the identifiers and nothing gate-derived', () => {
  const GATE_SOURCE = 'assert parse("a,b") == ["a","b"]  # SECRET_EXPECTED_VALUE_9731';
  const fails = ['test_quoted_fields', 'test_empty_line'];
  const surgical = buildSurgicalPrompt(SPEC, 'code', fails[0], fails.slice(1));
  const consolidation = buildConsolidationPrompt(SPEC, fails);
  for (const p of [surgical, consolidation]) {
    for (const f of fails) assert.ok(p.includes(f), 'check identifiers are the feedback');
    assert.ok(!p.includes(GATE_SOURCE), 'no gate source');
    assert.ok(!p.includes('SECRET_EXPECTED_VALUE_9731'), 'no expected values');
  }
});

// ---------- runGateFirst: probe / ensemble / climb ----------

test('probe green on first call -> solved, 1 round, stopReason green', async () => {
  const { effects, seen } = makeEffects({
    generate: async () => ({ text: fenced('perfect()'), costUsd: 0.001 }),
    gate: () => ({ score: [5, 5], fails: [] }),
  });
  const r = await runGateFirst({ spec: SPEC, gateCmd: ['python3', 'gate.py'], config: CONFIG, effects });
  assert.equal(r.solved, true);
  assert.equal(r.stopReason, 'green');
  assert.equal(r.roundsUsed, 1);
  assert.deepEqual(r.score, [5, 5]);
  assert.deepEqual(r.fails, []);
  assert.equal(r.finalText, 'perfect()');
  assert.equal(r.escalated, false);
  assert.ok(Math.abs(r.costUsd - 0.001) < 1e-9);
  assert.equal(seen.generate.length, 1);
  assert.equal(seen.generate[0].model, 'c1');
  assert.ok(seen.generate[0].prompt.includes(SPEC));
  assert.ok(Array.isArray(r.log) && r.log.length > 0);
});

test('probe failure -> sequential ensemble with cheap[1..seedN); ratchet keeps the best', async () => {
  const byModel = {
    c1: { text: fenced('v1'), gate: { score: [1, 4], fails: ['fA', 'fB', 'fC'] } },
    c2: { text: fenced('v2'), gate: { score: [2, 4], fails: ['fA', 'fB'] } },
    c3: { text: fenced('v3'), gate: { score: [4, 4], fails: [] } },
  };
  const { effects, seen } = makeEffects({
    generate: async ({ model }) => ({ text: byModel[model].text }),
    gate: (text) => {
      for (const m of Object.keys(byModel)) if (text === extractArtifact(byModel[m].text)) return byModel[m].gate;
      return { score: [0, 4], fails: ['fX'] };
    },
  });
  const r = await runGateFirst({ spec: SPEC, gateCmd: 'gate', config: CONFIG, effects });
  assert.equal(r.solved, true);
  assert.equal(r.finalText, 'v3');
  assert.equal(r.roundsUsed, 3); // probe + 2 ensemble mates
  assert.deepEqual(seen.generate.map((g) => g.model), ['c1', 'c2', 'c3']);
});

test('surgical prompts carry ONLY check identifiers from fails[] (end-to-end trust boundary)', async () => {
  let round = 0;
  const { effects, seen } = makeEffects({
    generate: async () => ({ text: fenced(`try-${(round += 1)}`) }),
    gate: (text) => (text === 'try-4' ? { score: [3, 3], fails: [] } : { score: [1, 3], fails: ['check_alpha', 'check_beta'] }),
  });
  const config = { cheap: ['c1', 'c2'], ladder: ['big1'], budget: 12, seedN: 2, perCallTimeoutMs: 5000 };
  const r = await runGateFirst({ spec: SPEC, gateCmd: ['python3', '/trusted/gate.py'], config, effects });
  assert.equal(r.solved, true);
  const surgicalPrompts = seen.generate.slice(2).map((g) => g.prompt); // after probe + 1 ensemble mate
  assert.ok(surgicalPrompts.length > 0);
  for (const p of surgicalPrompts) {
    assert.ok(p.includes('check_alpha'));
    assert.ok(!p.includes('gate.py'), 'gate command/path never reaches a builder prompt');
    assert.ok(!p.includes('/trusted'), 'gate location never reaches a builder prompt');
  }
});

test('escalation to the ladder is surfaced via escalated:true', async () => {
  let n = 0;
  const { effects, seen } = makeEffects({
    generate: async ({ model }) => ({ text: fenced(`${model}-${(n += 1)}`) }),
    gate: (text) => (text.startsWith('big1') ? { score: [2, 2], fails: [] } : { score: [0, 2], fails: ['fHard'] }),
  });
  const config = { cheap: ['c1'], ladder: ['big1'], budget: 12, seedN: 1, perCallTimeoutMs: 5000 };
  const r = await runGateFirst({ spec: SPEC, gateCmd: 'gate', config, effects });
  assert.equal(r.solved, true);
  assert.equal(r.escalated, true);
  assert.ok(seen.generate.some((g) => g.model === 'big1'));
});

test('consolidation fires at plateau; its prompt lists the fails; temp is higher', async () => {
  const { effects, seen } = makeEffects({
    generate: async () => ({ text: fenced('same-old') }),
    gate: () => ({ score: [0, 2], fails: ['f_one', 'f_two'] }),
  });
  const config = { cheap: ['c1'], ladder: [], budget: 20, seedN: 1, perCallTimeoutMs: 5000 };
  const r = await runGateFirst({ spec: SPEC, gateCmd: 'gate', config, effects });
  assert.equal(r.solved, false);
  assert.equal(r.stopReason, 'plateau');
  const consolidation = seen.generate[seen.generate.length - 1];
  assert.match(consolidation.prompt, /fix ALL/i);
  assert.ok(consolidation.prompt.includes('f_one') && consolidation.prompt.includes('f_two'));
  assert.ok(consolidation.temperature > seen.generate[0].temperature, 'consolidation runs hotter');
});

test('budget exhaustion stops with best-so-far surfaced verbatim', async () => {
  const { effects } = makeEffects({
    generate: async () => ({ text: fenced('meh') }),
    gate: () => ({ score: [1, 3], fails: ['fA', 'fB'] }),
  });
  const config = { cheap: ['c1', 'c2', 'c3'], ladder: ['big1'], budget: 2, seedN: 1, perCallTimeoutMs: 5000 };
  const r = await runGateFirst({ spec: SPEC, gateCmd: 'gate', config, effects });
  assert.equal(r.solved, false);
  assert.equal(r.stopReason, 'budget');
  assert.equal(r.roundsUsed, 2);
  assert.deepEqual(r.score, [1, 3]);
  assert.deepEqual(r.fails, ['fA', 'fB']);
  assert.equal(r.finalText, 'meh');
});

test('no cheap models -> stop no-seed, never throws', async () => {
  const { effects } = makeEffects({
    generate: async () => ({ text: fenced('x') }),
    gate: () => ({ score: [1, 1], fails: [] }),
  });
  const r = await runGateFirst({ spec: SPEC, gateCmd: 'gate', config: { cheap: [], ladder: [] }, effects });
  assert.equal(r.solved, false);
  assert.equal(r.stopReason, 'no-seed');
  assert.equal(r.finalText, '');
});

// ---------- generate failures: log-and-continue, never crash ----------

test('a generate throw yields no candidate: the run continues and a later model still lands green', async () => {
  const { effects, seen } = makeEffects({
    generate: async ({ model }) => {
      if (model === 'c1') throw new Error('provider 500');
      return { text: fenced('good') };
    },
    gate: (text) => (text === 'good' ? { score: [2, 2], fails: [] } : { score: [0, 2], fails: ['fZ'] }),
  });
  const config = { cheap: ['c1', 'c2'], ladder: [], budget: 12, seedN: 2, perCallTimeoutMs: 5000 };
  const r = await runGateFirst({ spec: SPEC, gateCmd: 'gate', config, effects });
  assert.equal(r.solved, true);
  assert.equal(r.finalText, 'good');
  assert.deepEqual(seen.generate.map((g) => g.model).slice(0, 2), ['c1', 'c2']);
  assert.ok(r.log.some((e) => typeof e.note === 'string' && e.note.includes('provider 500')), 'failure is logged');
});

test('every generate failure still consumes budget: an always-throwing pool terminates, never crashes', async () => {
  const { effects, seen } = makeEffects({
    generate: async () => {
      throw new Error('always down');
    },
    gate: () => ({ score: [9, 9], fails: [] }),
  });
  const config = { cheap: ['c1', 'c2'], ladder: [], budget: 4, seedN: 2, perCallTimeoutMs: 5000 };
  const r = await runGateFirst({ spec: SPEC, gateCmd: 'gate', config, effects });
  assert.equal(r.solved, false);
  assert.ok(['budget', 'plateau'].includes(r.stopReason));
  assert.ok(seen.generate.length <= 4, 'bounded by budget');
  assert.equal(seen.gated.length, 0, 'nothing to gate when generate never yields');
});

test('per-call timeout: forwarded to EVERY generate call, and a hung call is abandoned', async () => {
  const { effects, seen } = makeEffects({
    generate: async ({ model }) => {
      if (model === 'c1') return new Promise(() => {}); // hangs forever
      return { text: fenced('rescued') };
    },
    gate: (text) => (text === 'rescued' ? { score: [1, 1], fails: [] } : { score: [0, 1], fails: ['f'] }),
  });
  const config = { cheap: ['c1', 'c2'], ladder: [], budget: 6, seedN: 2, perCallTimeoutMs: 100 };
  const r = await runGateFirst({ spec: SPEC, gateCmd: 'gate', config, effects });
  assert.equal(r.solved, true);
  assert.equal(r.finalText, 'rescued');
  for (const g of seen.generate) assert.equal(g.timeoutMs, 100);
});

// ---------- post-green QUAL-01 polish hook ----------

test('polish kept ONLY when non-regressive and still green', async () => {
  const { effects, seen } = makeEffects({
    generate: async () => ({ text: fenced('raw_but_correct') }),
    gate: (text) => (text === 'raw_but_correct' || text === 'polished_and_correct' ? { score: [3, 3], fails: [] } : { score: [0, 3], fails: ['f'] }),
    polish: () => 'polished_and_correct',
  });
  const r = await runGateFirst({ spec: SPEC, gateCmd: 'gate', config: CONFIG, effects });
  assert.equal(r.solved, true);
  assert.equal(r.finalText, 'polished_and_correct');
  assert.equal(seen.polishes, 1);
  assert.deepEqual(r.score, [3, 3]);
});

test('polish that regresses the gate is REVERTED (non-regressive fence)', async () => {
  const { effects } = makeEffects({
    generate: async () => ({ text: fenced('correct_v1') }),
    gate: (text) => (text === 'correct_v1' ? { score: [3, 3], fails: [] } : { score: [2, 3], fails: ['broke_one'] }),
    polish: () => 'pretty_but_broken',
  });
  const r = await runGateFirst({ spec: SPEC, gateCmd: 'gate', config: CONFIG, effects });
  assert.equal(r.solved, true);
  assert.equal(r.finalText, 'correct_v1', 'regression reverted');
  assert.deepEqual(r.score, [3, 3]);
  assert.deepEqual(r.fails, []);
});

test('polish returning null/throwing is skipped; a non-green run never polishes', async () => {
  const nullPolish = makeEffects({
    generate: async () => ({ text: fenced('fine') }),
    gate: () => ({ score: [1, 1], fails: [] }),
    polish: () => null,
  });
  const r1 = await runGateFirst({ spec: SPEC, gateCmd: 'gate', config: CONFIG, effects: nullPolish.effects });
  assert.equal(r1.finalText, 'fine');

  const neverGreen = makeEffects({
    generate: async () => ({ text: fenced('bad') }),
    gate: () => ({ score: [0, 1], fails: ['f'] }),
    polish: () => 'should-not-run',
  });
  const config = { cheap: ['c1'], ladder: [], budget: 3, seedN: 1, perCallTimeoutMs: 5000 };
  await runGateFirst({ spec: SPEC, gateCmd: 'gate', config, effects: neverGreen.effects });
  assert.equal(neverGreen.seen.polishes, 0, 'polish only runs post-green');
});

// ---------- fail-safety + result shape ----------

test('garbage inputs never throw; result always has the full shape', async () => {
  const r = await runGateFirst(undefined);
  for (const k of ['solved', 'score', 'fails', 'roundsUsed', 'escalated', 'stopReason', 'finalText', 'log', 'costUsd']) {
    assert.ok(k in r, `has ${k}`);
  }
  assert.equal(r.solved, false);
});

test('costUsd sums per-call costs when the effect reports them', async () => {
  let n = 0;
  const { effects } = makeEffects({
    generate: async () => ({ text: fenced(`t${(n += 1)}`), costUsd: 0.002 }),
    gate: (text) => (text === 't3' ? { score: [1, 1], fails: [] } : { score: [0, 1], fails: ['f'] }),
  });
  const config = { cheap: ['c1', 'c2', 'c3'], ladder: [], budget: 12, seedN: 3, perCallTimeoutMs: 5000 };
  const r = await runGateFirst({ spec: SPEC, gateCmd: 'gate', config, effects });
  assert.ok(Math.abs(r.costUsd - 0.006) < 1e-9);
});

// ---------- createDefaultEffects: the thin real-effects adapter ----------

test('createDefaultEffects: generate adapts to the chat surface (model, system+user messages, temp, timeout)', async () => {
  const chatCalls = [];
  const effects = createDefaultEffects({
    baseUrl: 'https://router.example',
    keyEnv: 'TEST_KEY_ENV',
    chat: async (args) => {
      chatCalls.push(args);
      return { text: 'reply-text', model: args.model };
    },
  });
  const out = await effects.generate({ model: 'cheap-1', system: 'sys', prompt: 'do it', temperature: 0.2, timeoutMs: 777 });
  assert.equal(out.text, 'reply-text');
  assert.equal(chatCalls.length, 1);
  const c = chatCalls[0];
  assert.equal(c.baseUrl, 'https://router.example');
  assert.equal(c.keyEnv, 'TEST_KEY_ENV');
  assert.equal(c.model, 'cheap-1');
  assert.equal(c.timeoutMs, 777);
  assert.equal(c.temperature, 0.2);
  assert.deepEqual(c.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(c.messages[1].content, 'do it');
});

test('createDefaultEffects: writeArtifact persists to scratch and returns the path; now() ticks', () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfe-scratch-'));
  const effects = createDefaultEffects({ scratchDir, chat: async () => ({ text: '' }) });
  const p1 = effects.writeArtifact('hello world');
  assert.ok(p1.startsWith(scratchDir));
  assert.equal(fs.readFileSync(p1, 'utf8'), 'hello world');
  const p2 = effects.writeArtifact('second');
  assert.notEqual(p1, p2);
  assert.equal(typeof effects.now(), 'number');
});

test('createDefaultEffects: runGate drives the canonical gate contract (fixture gate, no network)', () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfe-gate-'));
  const gateScript = path.join(scratchDir, 'gate.cjs');
  fs.writeFileSync(gateScript, 'console.log("FAIL check_x");\nconsole.log("gate: 1/2");\n');
  const effects = createDefaultEffects({ scratchDir, chat: async () => ({ text: '' }) });
  const artifactPath = effects.writeArtifact('candidate');
  const r = effects.runGate({ gateCmd: [process.execPath, gateScript], artifactPath });
  assert.deepEqual(r.score, [1, 2]);
  assert.deepEqual(r.fails, ['check_x']);
});
