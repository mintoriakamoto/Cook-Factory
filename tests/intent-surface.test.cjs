'use strict';

/**
 * THE SEMANTIC LAYER: THE ONLY THING THE MODEL READS BEFORE IT DECIDES.
 *
 * A skill's `description` is the entire basis on which a runtime decides whether
 * that skill applies to what the user just said. Superpowers gets its whole
 * effect from this one field, written as an instruction rather than a summary:
 * "You MUST use this before any creative work: creating features, building
 * components, adding functionality, or modifying behavior."
 *
 * Ferrox had 7 of 74 written that way. The other 67 described WHAT the command
 * does and never WHEN to reach for it ("Generate tests for a completed phase
 * based on UAT criteria and implementation"), so nothing could fire on intent.
 *
 * ─── WHY THIS LAYER IS TESTED AND THE HOOK LAYER IS NOT YET BUILT ────────────
 *
 * These 2 layers have opposite interruption costs. The model reads a description
 * SILENTLY and acts only when it was already going to act, so this layer cannot
 * over-offer no matter how many entries it has. A prompt hook interrupts on every
 * fire whether it lands or not. So the value goes here first, where the nag risk
 * is structurally zero.
 *
 * ─── WHAT IS ASSERTED, AND WHAT DELIBERATELY IS NOT ──────────────────────────
 *
 * Not "the description is good", which is unfalsifiable. The arms below assert
 * machine checkable properties: a budget that is now ENFORCED, an absence of
 * named jargon on the beginner facing commands, a floor on situational phrasing,
 * and that the routing table names only commands that ship.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CMD_DIR = path.join(ROOT, 'commands', 'ferrox');

/** Every shipped command's stem and description, parsed from frontmatter. */
function descriptions() {
  const out = new Map();
  for (const f of fs.readdirSync(CMD_DIR)) {
    if (!f.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(CMD_DIR, f), 'utf-8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) continue;
    const m = fm[1].match(/^description:\s*(.+)$/m);
    if (!m) continue;
    let d = m[1].trim();
    if (d.startsWith('"') && d.endsWith('"')) d = d.slice(1, -1);
    out.set(f.slice(0, -3), d);
  }
  return out;
}

/**
 * The 9 a beginner meets. These carry the on ramp, so their descriptions are
 * held to a stricter standard than the expert surface.
 */
const BEGINNER = Object.freeze([
  'new-project', 'next', 'plan-phase', 'execute-phase',
  'verify-work', 'ship', 'debug', 'undo', 'help',
]);

/**
 * Terms that mean nothing to somebody who has never built software. Each one was
 * observed in a shipped description. "phase" is NOT on this list: it is
 * unavoidable in the command names themselves and is instead DEFINED in the
 * newcomer tour, which `tests/on-ramp.test.cjs` asserts.
 */
const JARGON = Object.freeze([
  'UAT', 'Nyquist', 'wave-based', 'subagent', 'manifest', 'SPIDR',
  'frontier mode', 'CRUD', 'atomic commit', 'Socratic', 'idempotent',
]);

test('the description set is NON EMPTY and complete', () => {
  const d = descriptions();
  // Denominator first. Every arm below is vacuous over an empty map, and an empty
  // map is exactly what a frontmatter parsing regression produces.
  assert.ok(d.size >= 70, `expected 70+ shipped commands, parsed ${d.size}`);
  for (const [stem, desc] of d) {
    assert.ok(desc.trim().length > 0, `${stem} has an empty description`);
  }
});

test('THE 100 CHAR BUDGET IS NOW ENFORCED, not merely declared', () => {
  // scripts/lint-descriptions.cjs declared this budget and was NOT wired into
  // lint:ci, so a 229 character description shipped under a 100 character limit.
  // A gate that never runs is a comment.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  assert.ok(
    pkg.scripts['lint:ci'].includes('lint-descriptions'),
    'lint:ci must run the description linter, or the budget is unenforced again',
  );
  const d = descriptions();
  const over = [...d].filter(([, desc]) => desc.length > 100);
  assert.deepStrictEqual(
    over.map(([s, desc]) => `${s} (${desc.length})`), [],
    'these descriptions exceed the declared budget',
  );
});

test('THE BEGINNER 9 CARRY NO JARGON', () => {
  const d = descriptions();
  const offenders = [];
  for (const stem of BEGINNER) {
    const desc = d.get(stem);
    assert.ok(desc, `${stem} must ship, it is on the on ramp`);
    for (const term of JARGON) {
      if (desc.toLowerCase().includes(term.toLowerCase())) {
        offenders.push(`${stem}: "${term}"`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    `the 9 commands a beginner meets must not use expert vocabulary:\n${offenders.join('\n')}`,
  );
});

test('THE JARGON DETECTOR CAN FIRE', () => {
  // Required failing arm. The list above is a substring search, and a search whose
  // needles appear nowhere is indistinguishable from a search that is broken.
  const planted = 'Validate built features through conversational UAT with wave-based parallelization';
  const hits = JARGON.filter((t) => planted.toLowerCase().includes(t.toLowerCase()));
  assert.ok(hits.length >= 2, `the detector missed planted jargon, found: ${hits.join(', ')}`);
  assert.ok(hits.includes('UAT'), 'UAT must be detected');
});

test('MOST descriptions name a SITUATION, asserted as a counted floor', () => {
  // Deliberately a FLOOR on a counter, not a per-entry rule. English cannot be
  // regex-checked for "names a situation" without false negatives, so this arm
  // guards against wholesale regression (someone reverting the set) rather than
  // pretending to grade each line. The 6 ns-* entries are bundle routers whose
  // pipe form is a deliberate convention and are excluded by name.
  const d = descriptions();
  const graded = [...d].filter(([stem]) => !stem.startsWith('ns-'));
  assert.ok(graded.length >= 65, `must grade a real set, got ${graded.length}`);

  const SITUATIONAL = /\b(you |your |something |a step |when |before |after |ready |coming back|about to|building|finished|writing|says?|asks?|wants?|reports?|describes?)/i;
  const situational = graded.filter(([, desc]) => SITUATIONAL.test(desc));
  const pct = Math.floor((situational.length / graded.length) * 100);
  assert.ok(
    pct >= 75,
    `only ${pct}% of descriptions name a situation (${situational.length}/${graded.length}); `
      + 'this started at 9% and the on ramp depends on it staying high',
  );
});

/* ------------------------------------------------------------------------ *
 * The standing bias: the generated instruction file
 * ------------------------------------------------------------------------ */

const profileOutput = require(path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'profile-output.cjs'));

/** Render the workflow enforcement block the way a real project receives it. */
function enforcementBlock() {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-claudemd-'));
  try {
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{"runtime":"claude"}');
    const out = path.join(dir, 'CLAUDE.md');
    profileOutput.cmdGenerateClaudeMd(dir, { output: out });
    const text = fs.readFileSync(out, 'utf-8');
    const start = text.indexOf('## Ferrox Workflow Enforcement');
    assert.notStrictEqual(start, -1, 'the generated file must carry the enforcement section');
    const end = text.indexOf('workflow-end', start);
    return text.slice(start, end === -1 ? undefined : end);
  } finally {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
}

test('THE INSTRUCTION FILE ROUTES BY SITUATION and names the entry point', () => {
  // This block is injected into EVERY session and previously named 3 of 74
  // commands, all of them mid work. `new-project` was absent, so a user who
  // cleared context and said "ok, build it" was routed to `quick`, the small
  // ad-hoc task command, straight past the roadmap they had just built.
  const block = enforcementBlock();
  assert.ok(block.length > 300, `the block must be substantial, got ${block.length} chars`);

  for (const needed of ['new-project', 'progress', 'next', 'plan-phase', 'execute-phase',
    'verify-work', 'ship', 'debug', 'undo', 'quick', 'help']) {
    assert.ok(
      block.includes(`/ferrox-${needed}`),
      `the routing table must name /ferrox-${needed}`,
    );
  }
  // It must route on SITUATION, which is what makes the model able to match.
  assert.ok(block.includes('When the user'), 'the table must be keyed on the user\'s situation');
  // And it must name the carrier, or "build it all" has no destination.
  assert.ok(block.includes('--auto'), 'the block must name the carry');
});

test('THE INSTRUCTION FILE EMITS ONLY ROUTABLE COMMANDS', () => {
  // Same defect class as smart-entry: the colon form is unroutable (#2808). This
  // block is generated per runtime, so it must project like everything else.
  const block = enforcementBlock();
  assert.ok(!block.includes('/ferrox:'), 'the generated block must not carry the colon form');

  // Every command it names must actually ship, or the standing instruction sends
  // the model at something absent on every prompt of every session.
  const shipped = new Set(
    fs.readdirSync(CMD_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)),
  );
  assert.ok(shipped.size > 40, `shipped set must be real, got ${shipped.size}`);
  const named = [...new Set([...block.matchAll(/\/ferrox-([a-z][a-z0-9-]*)/g)].map((m) => m[1]))];
  assert.ok(named.length >= 10, `the block must name 10+ commands, named ${named.length}`);
  const absent = named.filter((n) => !shipped.has(n));
  assert.deepStrictEqual(absent, [], `the instruction file names commands that do not ship: ${absent}`);
});

test('THE SHIPPED TEMPLATE DOCS MATCH THE GENERATOR', () => {
  // ferrox-core/templates/claude-md.md documents what the generator emits. When
  // the 2 disagree, the docs teach a shape the product does not produce, which is
  // the same contradiction found between new-project's workflow and its SKILL.md.
  const tpl = fs.readFileSync(path.join(ROOT, 'ferrox-core', 'templates', 'claude-md.md'), 'utf-8');
  const block = enforcementBlock();
  assert.ok(tpl.includes('When the user'), 'the template must document the situation table');
  for (const needed of ['new-project', 'ship', 'undo', 'next']) {
    assert.ok(
      tpl.includes(`/ferrox:${needed}`),
      `the template must document ${needed}, which the generator emits`,
    );
    assert.ok(block.includes(`/ferrox-${needed}`), `the generator must emit ${needed}`);
  }
});
