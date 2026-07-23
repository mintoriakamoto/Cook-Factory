'use strict';

/**
 * v1.10 Wave 3: the brainstorm-artifact gate (agent-ops pack, tier 2, hygiene floor).
 * v1.12 Wave 2: template-keyed per GATE-CARD-SPEC section 9 (software + book).
 *
 * Per-check unit coverage (BA-01..BA-06 provoked and cleared on BOTH templates),
 * template resolution (frontmatter, --template override, legacy default, unknown
 * fail-closed), fluent-pool assurance for both pools, and the sealed end-to-end path
 * through the templated framework: generate -> seal into a temp FERROX_SEALED_STORE ->
 * validateGateCard green with both references M/M and all 10 mutants caught, plus
 * per-template replay determinism and the repo-visibility rejection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const seal = require('../ferrox-core/bin/lib/gate-seal.cjs');
const gateRunner = require('../ferrox-core/bin/lib/gate-runner.cjs');
const gen = require('../gates/brainstorm-artifact/fixtures/generators/generators.cjs');

const GATE = path.join(__dirname, '..', 'gates', 'brainstorm-artifact', 'gate.cjs');
const CARD_FILE = path.join(__dirname, '..', 'gates', 'brainstorm-artifact', 'card.md');
const NONCE = 'w3ba';

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const FIX = mkTemp('brainstorm-gate-fix-');
const WS = gen.buildWorkspace(path.join(FIX, 'ws'));
const GATE_CMD = [process.execPath, GATE, '--workspace', WS];

let artifactCounter = 0;
function runOn(content, gateCmd = GATE_CMD) {
  const artifactPath = path.join(FIX, `artifact-${artifactCounter++}.md`);
  fs.writeFileSync(artifactPath, content);
  return gateRunner.runGate({ gateCmd, artifactPath });
}

function mutant(id) {
  return gen.mutants({ nonce: NONCE }).find((m) => m.id === id);
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function initRepo(files) {
  const repo = mkTemp('brainstorm-gate-repo-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'wave3@ferrox.local']);
  git(repo, ['config', 'user.name', 'Ferrox Wave3']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'hermetic wave3 repo']);
  return repo;
}

// ---------- reference ----------

test('reference brainstorm scores 6/6 with zero fails', () => {
  const r = runOn(gen.referenceContent({ nonce: NONCE }));
  assert.deepEqual(r, { score: [6, 6], fails: [] });
});

test('without --workspace the dead-ref scan degrades open (documented)', () => {
  const r = runOn(mutant('ba-m3').content, [process.execPath, GATE]);
  assert.deepEqual(r.score, [6, 6]);
});

// ---------- per-check units ----------

test('BA-01: a missing Recommendation section fails structure (and the pick check)', () => {
  const r = runOn(mutant('ba-m1').content);
  assert.deepEqual(r.fails, ['BA-01 structure', 'BA-02 structure']);
});

test('BA-01: required sections out of template order fail', () => {
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace('## Open Questions', '## SWAPMARKER')
    .replace('## Next Step', '## Open Questions')
    .replace('## SWAPMARKER', '## Next Step');
  const r = runOn(content);
  assert.equal(r.fails.includes('BA-01 structure'), true);
});

test('BA-02: a polished hedge with no pick fails exactly the pick check', () => {
  const r = runOn(mutant('ba-m2').content);
  assert.deepEqual(r.fails, ['BA-02 structure']);
});

test('BA-02: a Recommendation under the length floor fails', () => {
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace(/## Recommendation\n\n[\s\S]*?\n\n## Decisions/, '## Recommendation\n\nOption B.\n\n## Decisions');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-02 structure']);
});

test('BA-03: em dashes in otherwise perfect prose fail the editorial floor', () => {
  const r = runOn(mutant('ba-m4').content);
  assert.deepEqual(r.fails, ['BA-03 value']);
});

test('BA-03: an en dash fails the editorial floor', () => {
  const content = gen.referenceContent({ nonce: NONCE }).replace('local file only.', 'local file only – always.');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-03 value']);
});

test('BA-03: spelled-out numbers before countable nouns fail', () => {
  const content = gen.referenceContent({ nonce: NONCE }) + '\nWe tried this two times before settling.\n';
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-03 value']);
});

test('BA-04: a plausible-but-renamed file path fails the dead-ref scan', () => {
  const r = runOn(mutant('ba-m3').content);
  assert.deepEqual(r.fails, ['BA-04 grounding']);
});

test('BA-05: an empty Open Questions section fails', () => {
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace(/## Open Questions\n\n[\s\S]*?\n\n## Next Step/, '## Open Questions\n\n## Next Step');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-05 structure']);
});

test('BA-05: an empty Next Step section fails', () => {
  const content = gen.referenceContent({ nonce: NONCE }).replace(/## Next Step\n\n[\s\S]*$/, '## Next Step\n');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-05 structure']);
});

test('BA-06: a fluently buried TBD fails the placeholder scan', () => {
  const r = runOn(mutant('ba-m5').content);
  assert.deepEqual(r.fails, ['BA-06 value']);
});

test('BA-06: lorem ipsum filler fails the placeholder scan', () => {
  const content = gen.referenceContent({ nonce: NONCE }) + '\nLorem ipsum dolor sit amet.\n';
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-06 value']);
});

// ---------- template resolution (v1.12 Wave 2) ----------

function bookMutant(id) {
  return gen.bookMutants({ nonce: NONCE }).find((m) => m.id === id);
}

test('legacy default: an artifact with no frontmatter gates as software (v1.10 compat rule)', () => {
  // The v1.10 reference has no frontmatter at all and must keep scoring 6/6.
  const r = runOn(gen.referenceContent({ nonce: NONCE }));
  assert.deepEqual(r, { score: [6, 6], fails: [] });
});

test('frontmatter template: book routes the book check set', () => {
  const r = runOn(gen.bookReferenceContent({ nonce: NONCE }));
  assert.deepEqual(r, { score: [6, 6], fails: [] });
});

test('--template flag overrides frontmatter (book artifact forced onto the software set fails)', () => {
  const r = runOn(gen.bookReferenceContent({ nonce: NONCE }), [
    process.execPath,
    GATE,
    '--workspace',
    WS,
    '--template',
    'software',
  ]);
  assert.equal(r.fails.includes('BA-01 structure'), true, 'software sections are absent from a book doc');
});

test('unknown declared template fails closed with a structure FAIL on BA-01', () => {
  // campaign is declared in the workflow but its pack has not shipped: per the ADR a
  // template without its block and pool does not exist, and the artifact fails closed.
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace(
      '# Brainstorm: session capture for the audit trail',
      '---\ntemplate: campaign\nstatus: captured\n---\n\n# Brainstorm: session capture for the audit trail'
    );
  const r = runOn(content);
  assert.equal(r.fails.includes('BA-01 structure'), true);
  assert.equal(r.score[1], 6, 'denominator stays 6; the rest score against the software set');
});

// ---------- book per-check units ----------

test('book reference: em dashes in prose are WAIVED (the BA-03-book carve-out, live)', () => {
  const content = gen.bookReferenceContent({ nonce: NONCE });
  assert.equal(content.includes('—'), true, 'the reference genuinely carries em dashes in prose');
  const r = runOn(content);
  assert.deepEqual(r.fails, []);
});

test('book BA-03: an em dash in a heading line still fails (ban retained in structure)', () => {
  const content = gen
    .bookReferenceContent({ nonce: NONCE })
    .replace('# Brainstorm: the flare courier', '# Brainstorm: the flare courier — a mesh noir');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-03 value']);
});

test('book BA-03: an en dash in the frontmatter block still fails (ban retained there)', () => {
  const content = gen.bookReferenceContent({ nonce: NONCE }).replace('status: parked', 'status: parked – warm');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-03 value']);
});

test('book BA-01: a premise-free worldbuilding doc fails structure', () => {
  const r = runOn(bookMutant('bk-m1').content);
  assert.deepEqual(r.fails, ['BA-01 structure']);
});

test('book BA-01: an empty Threads section fails (a heading is not a section)', () => {
  const r = runOn(bookMutant('bk-m2').content);
  assert.deepEqual(r.fails, ['BA-01 structure']);
});

test('book BA-02: a hedge-soup Decisions section fails the definite-wording rule', () => {
  const r = runOn(bookMutant('bk-m3').content);
  assert.deepEqual(r.fails, ['BA-02 structure']);
});

test('book BA-01: a skipped Tone section with plausible flow fails structure', () => {
  const r = runOn(bookMutant('bk-m4').content);
  assert.deepEqual(r.fails, ['BA-01 structure']);
});

test('book BA-04: a plausibly renamed lore path fails the dead-ref scan', () => {
  const r = runOn(bookMutant('bk-m5').content);
  assert.deepEqual(r.fails, ['BA-04 grounding']);
});

test('book BA-02: a hedged Next Step fails (a hedge is not an action); park phrasing passes', () => {
  // The reference Next Step is park phrasing ("Keep it warm: ...") and passes above.
  const content = gen
    .bookReferenceContent({ nonce: NONCE })
    .replace(/## Next Step\n\n[\s\S]*$/, '## Next Step\n\nHard to say what comes next until the world settles a bit more.\n');
  const r = runOn(content);
  assert.equal(r.fails.includes('BA-02 structure'), true);
});

test('book BA-05: an empty Open Questions section fails', () => {
  const content = gen
    .bookReferenceContent({ nonce: NONCE })
    .replace(/## Open Questions\n\n[\s\S]*?\n\n## Next Step/, '## Open Questions\n\n## Next Step');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-05 structure']);
});

test('book BA-06: a fluent TBD fails the placeholder scan on the book set too', () => {
  const content = gen
    .bookReferenceContent({ nonce: NONCE })
    .replace('- Who ordered the flare,', '- Casting for the Archivist: TBD pending the next pass.\n- Who ordered the flare,');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-06 value']);
});

// ---------- surface + card contract ----------

test('every emitted FAIL token is v2 and inside the committed card inventory', () => {
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  assert.equal(parsed.ok, true);
  const inventory = new Map(parsed.card.checks.map((c) => [c.id, c.category]));
  const rotten = [
    '# Brainstorm: rotten',
    '',
    '## Context',
    '',
    'Sketchy notes — with a dash, a TODO, and a dead `src/never-existed.cjs` path.',
    '',
    '## Decisions',
    '',
    'None yet.',
    '',
  ].join('\n');
  const worst = runOn(rotten);
  assert.equal(worst.fails.length >= 4, true, `broad-failure artifact dropped ${worst.fails.length}`);
  for (const fail of worst.fails) {
    const cls = gateRunner.classifyFail(fail);
    assert.equal(cls.v2, true, `${fail} is v2`);
    assert.equal(inventory.get(cls.id), cls.category, `${fail} in inventory`);
  }
});

test('committed card declares the 6-check inventory and per-template 5-mutant fluent pools', () => {
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.card.gateId, 'brainstorm-artifact');
  assert.deepEqual(
    parsed.card.checks.map((c) => c.id),
    ['BA-01', 'BA-02', 'BA-03', 'BA-04', 'BA-05', 'BA-06']
  );
  // Templated card (GATE-CARD-SPEC section 9): no top-level validation block,
  // software + book each with a full fluent pool of 5.
  assert.equal(parsed.card.hasTopLevelValidation, false);
  assert.notEqual(parsed.card.templates, null);
  assert.deepEqual(parsed.card.templates.map((t) => t.slug).sort(), ['book', 'software']);
  for (const t of parsed.card.templates) {
    assert.equal(t.poolMin, 5, `${t.slug} pool_min`);
    assert.equal(t.mutants.length, 5, `${t.slug} pool size`);
    assert.equal(t.mutants.every((m) => m.mutantClass === 'fluent-but-wrong'), true, `${t.slug} pool class`);
    assert.equal(t.poolStatus, 'full', `${t.slug} pool_status`);
  }
});

// ---------- fluent pool assurance (both templates) ----------

test('every software pool mutant drops >= expected_drop and emits every must_fail id', () => {
  for (const m of gen.mutants({ nonce: NONCE })) {
    const r = runOn(m.content);
    assert.equal(r.fails.length >= m.expectedDrop, true, `${m.id} dropped ${r.fails.length}`);
    const ids = new Set(r.fails.map((f) => f.split(' ')[0]));
    for (const id of m.mustFail) {
      assert.equal(ids.has(id), true, `${m.id} must fail ${id}`);
    }
  }
});

test('every book pool mutant drops >= expected_drop and emits every must_fail id', () => {
  for (const m of gen.bookMutants({ nonce: NONCE })) {
    const r = runOn(m.content);
    assert.equal(r.fails.length >= m.expectedDrop, true, `${m.id} dropped ${r.fails.length}`);
    const ids = new Set(r.fails.map((f) => f.split(' ')[0]));
    for (const id of m.mustFail) {
      assert.equal(ids.has(id), true, `${m.id} must fail ${id}`);
    }
  }
});

// ---------- sealed end-to-end through the templated framework (section 9) ----------

/** Seal both template pools into a fresh store and return cardMarkdown args. */
function sealBothPools(store, nonce) {
  const put = (content) => {
    const r = seal.sealPut({ content, storeRoot: store });
    assert.equal(r.ok, true);
    return r;
  };
  return {
    software: {
      referenceUri: put(gen.referenceContent({ nonce })).uri,
      mutants: gen.mutants({ nonce }).map((m) => ({ ...m, fixtureUri: put(m.content).uri })),
    },
    book: {
      referenceUri: put(gen.bookReferenceContent({ nonce })).uri,
      mutants: gen.bookMutants({ nonce }).map((m) => ({ ...m, fixtureUri: put(m.content).uri })),
    },
  };
}

test('e2e: seal both pools, validateGateCard green, both refs M/M, all 10 mutants caught', () => {
  const store = mkTemp('brainstorm-gate-store-');
  const repo = initRepo({ 'README.md': 'clean hermetic repo\n' });
  const pools = sealBothPools(store, gen.mintNonce());

  const card = gen.cardMarkdown({ ...pools, rotationK: 5 });
  const r = seal.validateGateCard(card, {
    repoRoot: repo,
    storeRoot: store,
    runId: 'W2-BRAINSTORM-01',
    gateCmd: GATE_CMD,
    gateScriptPath: GATE,
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.runRecord.gateId, 'brainstorm-artifact');
  for (const slug of ['software', 'book']) {
    const record = r.runRecord.templates[slug];
    assert.deepEqual(record.referenceScore, [6, 6], `${slug} reference is M/M`);
    assert.equal(record.sampled.length, 5, `${slug} rotation_k 5 samples the full pool`);
    for (const s of record.sampled) {
      assert.equal(s.fails.length >= 1, true, `${slug} ${s.id} was caught`);
    }
  }
});

test('e2e: replaying the same runId reproduces both per-template samples', () => {
  const store = mkTemp('brainstorm-gate-store-');
  const pools = sealBothPools(store, gen.mintNonce());
  const card = gen.cardMarkdown({ ...pools, rotationK: 2 });
  const first = seal.validateGateCard(card, { storeRoot: store, runId: 'W2-BRAINSTORM-REPLAY' });
  const second = seal.validateGateCard(card, { storeRoot: store, runId: 'W2-BRAINSTORM-REPLAY' });
  for (const slug of ['software', 'book']) {
    assert.deepEqual(
      first.runRecord.templates[slug].sampled.map((s) => s.id),
      second.runRecord.templates[slug].sampled.map((s) => s.id)
    );
    assert.equal(first.runRecord.templates[slug].sampled.length, 2);
  }
});

test('e2e: sealing fixture content that is committed in the repo is rejected, not laundered', () => {
  const store = mkTemp('brainstorm-gate-store-');
  const nonce = gen.mintNonce();
  const bookRefContent = gen.bookReferenceContent({ nonce });
  const repo = initRepo({ '.planning/brainstorms/committed/BRAINSTORM.md': bookRefContent });

  const pools = sealBothPools(store, nonce);
  const card = gen.cardMarkdown({ ...pools, rotationK: 5 });
  const r = seal.validateGateCard(card, { repoRoot: repo, storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_FIXTURE_REPO_VISIBLE');
  assert.equal(
    r.errors.some((e) => e.code === 'E_FIXTURE_REPO_VISIBLE' && e.role === 'reference' && e.template === 'book'),
    true
  );
});

test('e2e: the seal-recorded gate script hash keys last_validated for BOTH templates', () => {
  const store = mkTemp('brainstorm-gate-store-');
  const pools = sealBothPools(store, gen.mintNonce());
  const currentHash = seal.sha256HexOf(fs.readFileSync(GATE));
  const dates = { software: '2026-07-23', book: '2026-07-23' };

  const intact = seal.validateGateCard(
    gen.cardMarkdown({ ...pools, rotationK: 2, lastValidated: dates, gateScriptHash: currentHash }),
    { storeRoot: store, runId: 'W2-BRAINSTORM-LV', gateScriptPath: GATE }
  );
  assert.deepEqual(intact.lastValidated, dates);

  // A gate script edit (hash change) nulls last_validated for ALL templates by design.
  const stale = seal.validateGateCard(
    gen.cardMarkdown({ ...pools, rotationK: 2, lastValidated: dates, gateScriptHash: 'f'.repeat(64) }),
    { storeRoot: store, runId: 'W2-BRAINSTORM-LV', gateScriptPath: GATE }
  );
  assert.deepEqual(stale.lastValidated, { software: null, book: null });
});
