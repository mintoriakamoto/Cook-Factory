'use strict';

/**
 * THE OFFER COUNTER, OVER THE LOG THE SYSTEM ACTUALLY WROTE.
 *
 * `foldOfferStats` has been correct since the day it shipped, and it has been
 * unit tested since the day it shipped, against synthetic logs. What it never
 * had was data. `hooks/ferrox-offer.js` wrote `shown` and nothing ever wrote
 * anything else, so `acceptanceRate` could only ever be 0 or null in the field
 * and the self retirement rule could not fire on real usage.
 *
 * That makes this file's shape non negotiable:
 *
 *   1. EVERY COUNT GOES THROUGH THE SHIPPED FOLD. A test that recounts the rows
 *      itself proves the test and not the system. `foldOfferStats` is required
 *      from the built lib and called on the bytes the hook appended.
 *   2. NOTHING ASSERTS THAT `logDecision` WAS CALLED. A producer with no
 *      consumer is invisible to a mutation battery: mutating a value nobody
 *      reads changes no observable behaviour and every arm still passes. The
 *      observable here is the counter, so the counter is what is asserted.
 *   3. THE COUNTER IS ASSERTED MOVING, AND THEN STOPPING. 0, then 1, then still
 *      1 on a repeat. An offer is accepted at most once, because a rate
 *      inflated by repetition is worse than no rate at all.
 *
 * DECLINED IS DELIBERATELY NEVER WRITTEN, and no arm below looks for one. There
 * is no event that means "the user decided against it". Someone who ignores an
 * offer and someone who rejects it are indistinguishable from the log, and the
 * fold already folds that population as `missed`, which is its honest name. A
 * synthetic `declined` row on a timeout would manufacture an outcome nobody
 * observed, which is the exact false measurement this milestone exists to stop.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REG = require(path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'offer-registry.cjs'));
const HOOK = path.join(ROOT, 'hooks', 'ferrox-offer.js');

/** The prompt that earns the `plan-it` offer. */
const SEAM_PROMPT = 'build me a game about trains';
/** The acceptance gesture: the user runs the command the offer named. */
const ACCEPT_PROMPT = '/ferrox-new-project';

function runHook(cwd, prompt) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, prompt }),
    encoding: 'utf-8',
    timeout: 10000,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function scratchProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-accept-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

function cleanup(dir) {
  try {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* best effort */ }
}

/** A real Ferrox project sitting at a seam, with no roadmap yet. */
function seamProject() {
  return {
    '.planning/config.json': '{"runtime":"claude"}',
    '.planning/STATE.md': '---\nstatus: unknown\n---\n# State\n',
  };
}

const LOG_PATH = (dir) => path.join(dir, '.planning', '.ferrox-offers.jsonl');
const MEM_PATH = (dir) => path.join(dir, '.planning', '.ferrox-offers.json');

/** The raw lines the SYSTEM wrote. Never a fixture. */
function readLog(dir) {
  const p = LOG_PATH(dir);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split(/\r?\n/);
}

function logRows(dir) {
  return readLog(dir).filter((l) => l.trim() !== '');
}

/** Counters for one offer, folded by the SHIPPED fold. */
function statsFor(dir, id) {
  return REG.foldOfferStats(readLog(dir))[id] || null;
}

/**
 * Show `plan-it` exactly `times` times, through the real hook, in one project.
 *
 * The edge brake is what makes this non trivial and it is also the reason the
 * arms below are honest: a standing condition is not news, so the only way to
 * earn a second `shown` row is to make the condition genuinely go away and come
 * back. Adding a roadmap makes `plan-it` ineligible and moves its edge value;
 * removing it moves the edge back and the offer becomes news again. Every row
 * this produces was written by the shipped hook for the shipped reason.
 */
function showOfferTimes(dir, times) {
  const bare = '---\nstatus: unknown\n---\n# State\n';
  const withPhases = '---\nstatus: unknown\ncurrent_phase: 1\ntotal_phases: 3\n---\n# State\n';
  const roadmap = path.join(dir, '.planning', 'ROADMAP.md');
  const state = path.join(dir, '.planning', 'STATE.md');
  for (let i = 0; i < times; i += 1) {
    if (i > 0) {
      fs.writeFileSync(roadmap, '# Roadmap\n## Phase 1: One\n## Phase 2: Two\n');
      fs.writeFileSync(state, withPhases);
      runHook(dir, SEAM_PROMPT); // re-arms the edge; makes no offer
      fs.unlinkSync(roadmap);
      fs.writeFileSync(state, bare);
    }
    const r = runHook(dir, SEAM_PROMPT);
    assert.ok(r.stdout.includes('/ferrox-new-project'), `show ${i + 1} of ${times} did not fire`);
  }
}

/* ------------------------------------------------------------------------ *
 * The counter moves
 * ------------------------------------------------------------------------ */

test('THE COUNTER MOVES 0 to 1 when the offer is shown and its command then runs', () => {
  const dir = scratchProject(seamProject());
  try {
    const shown = runHook(dir, SEAM_PROMPT);
    assert.ok(
      shown.stdout.includes('/ferrox-new-project'),
      `precondition: the offer must have been made, got: ${shown.stdout}`,
    );

    const before = statsFor(dir, 'plan-it');
    assert.strictEqual(before.shown, 1, 'precondition: exactly 1 shown row');
    assert.strictEqual(before.accepted, 0, 'precondition: nothing accepted yet');
    assert.strictEqual(before.acceptanceRate, 0, 'precondition: the rate starts at 0');

    const accept = runHook(dir, ACCEPT_PROMPT);
    assert.strictEqual(accept.status, 0, 'the hook must never break a session');

    const after = statsFor(dir, 'plan-it');
    assert.strictEqual(
      after.accepted, 1,
      `accepted must move 0 to 1 over the log the system wrote, got ${after.accepted}`,
    );
    assert.ok(
      after.acceptanceRate > 0,
      `acceptanceRate must leave 0, got ${after.acceptanceRate}`,
    );

    // AT MOST ONCE. The counter has to stop as hard as it moved: a rate
    // inflated by repetition is worse than a rate that is merely low, because
    // the retirement rule would then never fire on anything.
    runHook(dir, ACCEPT_PROMPT);
    runHook(dir, ACCEPT_PROMPT);
    const repeated = statsFor(dir, 'plan-it');
    assert.strictEqual(
      repeated.accepted, 1,
      `2 further runs of the same command must leave accepted at 1, got ${repeated.accepted}`,
    );
    assert.strictEqual(repeated.shown, 1, 'and the shown count must not drift either');
  } finally {
    cleanup(dir);
  }
});

test('A REAL ACCEPTANCE CHANGES WHAT retiredOffers RETURNS, which is the whole point', () => {
  // The criterion is that the v1.16 self retirement rule can fire on usage
  // rather than on fixtures. So the arm drives the rule, over 5 shown rows the
  // hook actually wrote, and asserts its VERDICT flips when the acceptance
  // lands. Nothing here is synthesised: the counterfactual is the same log at
  // the moment before the accept.
  const dir = scratchProject(seamProject());
  try {
    showOfferTimes(dir, REG.RETIREMENT_MIN_SHOWN);

    const beforeStats = REG.foldOfferStats(readLog(dir));
    assert.strictEqual(
      beforeStats['plan-it'].shown, REG.RETIREMENT_MIN_SHOWN,
      'precondition: enough real evidence for the rule to be allowed to judge',
    );
    assert.strictEqual(beforeStats['plan-it'].accepted, 0, 'precondition: an all shown log');
    assert.deepStrictEqual(
      REG.retiredOffers(beforeStats), ['plan-it'],
      'an offer shown 5 times and never accepted has proven it is noise',
    );

    runHook(dir, ACCEPT_PROMPT);

    const afterStats = REG.foldOfferStats(readLog(dir));
    assert.strictEqual(afterStats['plan-it'].accepted, 1, 'the acceptance must have landed');
    assert.deepStrictEqual(
      REG.retiredOffers(afterStats), [],
      'one real acceptance in 5 must lift the offer off the retirement floor',
    );
  } finally {
    cleanup(dir);
  }
});

test('A COMMAND NO OFFER DECLARES writes nothing, because it accepted nothing', () => {
  const dir = scratchProject(seamProject());
  try {
    runHook(dir, SEAM_PROMPT);
    const before = logRows(dir);
    assert.strictEqual(before.length, 1, 'precondition: 1 shown row');

    // A shipped command that no offer routes to. Running it is not an
    // acceptance of anything and must be completely silent.
    const stems = new Set(REG.OFFERS.map((o) => o.command));
    assert.ok(!stems.has('health'), 'fixture assumes no offer routes to /ferrox-health');
    const r = runHook(dir, '/ferrox-health');
    assert.strictEqual(r.status, 0);

    assert.deepStrictEqual(logRows(dir), before, 'an unrelated command must write no row');
    assert.strictEqual(statsFor(dir, 'plan-it').accepted, 0, 'and must move no counter');
  } finally {
    cleanup(dir);
  }
});

/* ------------------------------------------------------------------------ *
 * Totality. Telemetry that can break a session is worse than no telemetry
 * ------------------------------------------------------------------------ */

test('TOTALITY 1, no .planning/: nothing is written and nothing is thrown', () => {
  const dir = scratchProject({ 'README.md': 'not a Ferrox project\n' });
  try {
    assert.deepStrictEqual(
      REG.recordOfferAccepted(dir, 'new-project'), [],
      'a project with no .planning/ has no offers to accept',
    );
    const r = runHook(dir, ACCEPT_PROMPT);
    assert.strictEqual(r.status, 0, 'the hook must exit cleanly');
    assert.strictEqual(r.stdout.trim(), '', 'and say nothing');
    assert.ok(!fs.existsSync(path.join(dir, '.planning')), '.planning/ must not be conjured');
  } finally {
    cleanup(dir);
  }
});

test('TOTALITY 2, an UNREADABLE memory file: nothing is written and nothing is thrown', () => {
  const dir = scratchProject(seamProject());
  try {
    runHook(dir, SEAM_PROMPT);
    const before = logRows(dir);
    assert.strictEqual(before.length, 1, 'precondition: 1 shown row');

    // Two flavours, because "corrupt" and "cannot even be read" fail in
    // different places. Invalid JSON throws inside JSON.parse; a directory
    // where a file belongs throws EISDIR inside readFileSync.
    fs.writeFileSync(MEM_PATH(dir), '{ this is not json');
    assert.deepStrictEqual(REG.recordOfferAccepted(dir, 'new-project'), []);
    assert.deepStrictEqual(logRows(dir), before, 'corrupt memory must write no row');

    fs.unlinkSync(MEM_PATH(dir));
    fs.mkdirSync(MEM_PATH(dir));
    assert.deepStrictEqual(REG.recordOfferAccepted(dir, 'new-project'), []);
    assert.deepStrictEqual(logRows(dir), before, 'unreadable memory must write no row');

    const r = runHook(dir, ACCEPT_PROMPT);
    assert.strictEqual(r.status, 0, 'and the session survives either way');
  } finally {
    cleanup(dir);
  }
});

test('TOTALITY 3, a MALFORMED log line: it counts as nothing and stops nothing', () => {
  const dir = scratchProject(seamProject());
  try {
    runHook(dir, SEAM_PROMPT);
    fs.appendFileSync(LOG_PATH(dir), 'not json at all\n{"offer":null,"outcome":"accepted"}\n');

    const r = runHook(dir, ACCEPT_PROMPT);
    assert.strictEqual(r.status, 0, 'a poisoned log must not break the session');

    // The junk contributes to no counter, and the real acceptance still lands
    // behind it. A log is append only and one bad row must not cost the rest.
    const s = statsFor(dir, 'plan-it');
    assert.strictEqual(s.shown, 1, 'the malformed rows must add nothing to shown');
    assert.strictEqual(s.accepted, 1, 'the real acceptance still lands after the junk');
    assert.strictEqual(s.acceptanceRate, 1, 'and the rate is computed off the sound rows only');
  } finally {
    cleanup(dir);
  }
});

test('A MALFORMED SLASH PROMPT accepts nothing and exits cleanly', () => {
  const dir = scratchProject(seamProject());
  try {
    runHook(dir, SEAM_PROMPT);
    const before = logRows(dir);
    // A bare slash, an empty stem, and a stem that only looks like ours.
    for (const prompt of ['/', '/ferrox-', '//ferrox-new-project', 'ferrox-new-project']) {
      const r = runHook(dir, prompt);
      assert.strictEqual(r.status, 0, `hook exited ${r.status} on prompt: ${prompt}`);
    }
    assert.deepStrictEqual(logRows(dir), before, 'none of those is an acceptance');
    // The direct call, with the argument shapes a caller can get wrong.
    for (const stem of ['', null, undefined, 42, {}]) {
      assert.deepStrictEqual(REG.recordOfferAccepted(dir, stem), [], `stem ${String(stem)}`);
    }
  } finally {
    cleanup(dir);
  }
});

/* ------------------------------------------------------------------------ *
 * The decision that is NOT implemented, asserted so it stays deliberate
 * ------------------------------------------------------------------------ */

test('NO declined ROW IS EVER WRITTEN, on any path this suite can reach', () => {
  // D3. Someone who ignores an offer and someone who rejects it are
  // indistinguishable from this log, and the fold already folds that
  // population as `missed`, which is its honest name. A `declined` row on a
  // timeout would invent an outcome nobody observed. If a future change starts
  // writing one, this arm is where the argument has to be had.
  const dir = scratchProject(seamProject());
  try {
    showOfferTimes(dir, 3);
    runHook(dir, ACCEPT_PROMPT);
    runHook(dir, ACCEPT_PROMPT);
    runHook(dir, '/ferrox-health');
    runHook(dir, SEAM_PROMPT);

    const stats = REG.foldOfferStats(readLog(dir));
    assert.ok(Object.keys(stats).length > 0, 'the log must be non empty or this proves nothing');
    for (const [id, s] of Object.entries(stats)) {
      assert.strictEqual(s.declined, 0, `a declined row appeared for ${id}`);
    }
    for (const row of logRows(dir)) {
      assert.ok(!row.includes('"declined"'), `a declined outcome was written: ${row}`);
    }
    // And the control, so this is not passing over an empty or all-shown log.
    assert.strictEqual(stats['plan-it'].accepted, 1, 'control: an acceptance did land');
    assert.strictEqual(stats['plan-it'].shown, 3, 'control: the shown rows are real');
  } finally {
    cleanup(dir);
  }
});
