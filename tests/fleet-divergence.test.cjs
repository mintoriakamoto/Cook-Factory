'use strict';

/**
 * Phase 18 plan 02, task 4: the 3 deferred SC4 security fixes on the vendored
 * engine, each recorded as a divergence and each proven against the pristine
 * file reconstructed from the ledger itself.
 *
 * WHY THE RECONSTRUCTION COMES FIRST. Every one of these 3 fixes is the kind of
 * change that can be faked by adding a code path and asserting the code path
 * exists. So each one is driven TWICE: once against a scratch copy rebuilt from
 * the shipped file plus the ledger, where the defect is observed PRESENT, and
 * once against the shipped copy, where it is observed absent. The rebuild is
 * checked against the pristine sha256 in UPSTREAM-MANIFEST.json before any
 * driver runs, so a ledger that omits an edit fails loudly here rather than
 * letting every later arm pass quietly against a file that was never pristine.
 *
 * THE THIRD ARM. DIV-03 moves both untrusted paths into a throwaway clone, and
 * a clone that is deleted afterwards would explain a clean canonical repository
 * on its own, hiding whether DIV-02 does anything. So the hook survival exploit
 * is also driven against a copy carrying ONLY DIV-02, built by reversing the
 * other 2 entries. That arm is what shows the decode fix defusing the exploit
 * by itself rather than riding on the isolation.
 *
 * WHY THE DRIVERS ARE PYTHON. The subject is a Python entrypoint and the
 * defects are in its runtime behaviour, not in its text. tests/fixtures/
 * fleet-divergence-driver.py loads whichever copy it is pointed at as a library
 * by file location, which plan 01's 1 main guard property makes safe, and
 * prints a single JSON result. It states no expectation of its own: a driver
 * that knows which arm it is in can be written to agree with itself.
 *
 * NO SKIPPING. If the interpreter is absent this file FAILS naming it. A
 * divergence test that quietly skips is the exact defect class this phase
 * exists to stop.
 *
 * BYTECODE. Loading a vendored entrypoint makes the interpreter write a
 * bytecode directory next to the source. Every copy loaded below lives in a
 * scratch directory, never in the repository, and every child runs with
 * bytecode writing disabled. The absence of any artifact under the real
 * vendored tree is asserted at the end rather than assumed.
 *
 * NOT COVERED, stated plainly. These arms prove the 3 fixes changed behaviour.
 * They do not prove the engine is safe to run agents in: a setsid detached
 * child and an absolute path write outside the tree both still escape, exactly
 * as upstream's own honest boundary says, and both need an operating system
 * level sandbox. run_card still has no ref containment, which is a phase 19
 * entry gate rather than a phase 18 item.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const P = 'phase 18 plan 02 task 4';
const REPO_ROOT = path.join(__dirname, '..');
const VENDOR_ROOT = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'vendor', 'ratchet');
const EXEC_KEY = 'bin/ratchet-exec';
const EXEC_PATH = path.join(VENDOR_ROOT, 'bin', 'ratchet-exec');
const DRIVER = path.join(__dirname, 'fixtures', 'fleet-divergence-driver.py');
const BYTECODE_DIR = '__py' + 'cache__';

const MANIFEST = JSON.parse(fs.readFileSync(path.join(VENDOR_ROOT, 'UPSTREAM-MANIFEST.json'), 'utf8'));
const LEDGER = JSON.parse(fs.readFileSync(path.join(VENDOR_ROOT, 'DIVERGENCES.json'), 'utf8'));
const SHIPPED = fs.readFileSync(EXEC_PATH, 'utf8');

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-divergence-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

function sha256text(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * Reverse application. Replacing each entry's post block with its pre block is
 * order independent here, because the 3 regions are disjoint and contiguous and
 * every block occurs exactly once. Both of those properties are ASSERTED rather
 * than assumed, because a block that occurs twice would make the reconstruction
 * pick an arbitrary one and still produce a plausible file.
 */
function reverseApply(text, onlyIds) {
  let out = text;
  for (const d of LEDGER.divergences) {
    if (onlyIds && !onlyIds.includes(d.id)) continue;
    const first = out.indexOf(d.post);
    assert.notEqual(
      first,
      -1,
      `${P}: the post block for ${d.id} does not occur in the shipped file, so the ledger does not ` +
        'describe what actually shipped',
    );
    assert.equal(
      out.indexOf(d.post, first + 1),
      -1,
      `${P}: the post block for ${d.id} occurs more than once, so a reverse application would pick ` +
        'an arbitrary occurrence and still produce a plausible file',
    );
    out = out.slice(0, first) + d.pre + out.slice(first + d.post.length);
  }
  return out;
}

// ─── the reconstruction, and the 3 copies every driver arm is pointed at ─────

let VARIANTS = null;

function variants() {
  if (VARIANTS) return VARIANTS;
  const pristine = reverseApply(SHIPPED, null);
  const div02Only = reverseApply(SHIPPED, ['DIV-01', 'DIV-03']);
  const root = scratch('variants');
  const dirs = {};
  for (const [name, text] of [['pristine', pristine], ['div02', div02Only], ['shipped', SHIPPED]]) {
    const dir = path.join(root, name);
    fs.cpSync(path.join(VENDOR_ROOT, 'bin'), dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ratchet-exec'), text, 'utf8');
    fs.chmodSync(path.join(dir, 'ratchet-exec'), 0o755);
    dirs[name] = dir;
  }
  VARIANTS = { dirs, pristine, div02Only };
  return VARIANTS;
}

/**
 * Run 1 driver mode against 1 copy. The child gets a scratch HOME and no engine
 * home variables at all, so nothing it does can reach the operator's own state,
 * and bytecode writing is disabled so no artifact lands beside any copy.
 */
function drive(mode, arm, extra = []) {
  const { dirs } = variants();
  const home = scratch(`home-${mode}-${arm}`);
  const env = { ...process.env, HOME: home, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.RATCHET_HOME;
  delete env.WL_HOME;
  delete env.WL_MANIFEST;
  delete env.WL_INSTANCE;
  const r = spawnSync('python3', [DRIVER, mode, dirs[arm], ...extra], {
    encoding: 'utf8',
    env,
    timeout: 600000,
  });
  assert.ok(
    !r.error,
    `${P}: the python3 interpreter could not run the ${mode} driver (${r.error && r.error.message}). ` +
      'This file does NOT skip when the interpreter is absent, because a divergence test that ' +
      'quietly skips is the defect class this phase exists to stop.',
  );
  const line = String(r.stdout || '')
    .split(/\r?\n/)
    .find((l) => l.startsWith('RESULT '));
  assert.ok(
    line,
    `${P}: the ${mode} driver on the ${arm} copy printed no RESULT line. rc ${r.status}. ` +
      `stdout tail: ${String(r.stdout || '').slice(-400)} stderr tail: ${String(r.stderr || '').slice(-800)}`,
  );
  return JSON.parse(line.slice('RESULT '.length));
}

// ─── the ledger is COMPLETE, not merely present ──────────────────────────────

test(`${P}: reversing every ledger entry reproduces the pristine file byte for byte`, () => {
  const { pristine } = variants();
  const pinned = MANIFEST.files[EXEC_KEY].sha256;
  const rebuilt = sha256text(pristine);
  assert.equal(
    rebuilt,
    pinned,
    `${P}: the reverse applied reconstruction hashes ${rebuilt}, but the pristine pin is ${pinned}. ` +
      'That means the ledger does not account for every byte that changed, so every driver arm ' +
      'below would be comparing the shipped file against something that was never upstream.',
  );
  assert.equal(
    Buffer.from(pristine, 'utf8').length,
    MANIFEST.files[EXEC_KEY].bytes,
    `${P}: the reconstruction has the wrong byte length, so the hash match above would be luck`,
  );
});

test(`${P}: the ledger carries 3 entries, all naming 1 file, agreeing on the post state`, () => {
  const ds = LEDGER.divergences;
  assert.equal(ds.length, 3, `${P}: the ledger has ${ds.length} entries, expected 3`);
  const files = new Set(ds.map((d) => d.file));
  assert.deepEqual(
    [...files],
    [EXEC_KEY],
    `${P}: the ledger names ${[...files].join(', ')}. Only the exec entrypoint may diverge.`,
  );
  const ids = ds.map((d) => d.id);
  assert.deepEqual([...new Set(ids)].sort(), ['DIV-01', 'DIV-02', 'DIV-03'], `${P}: entry ids drifted`);
  const hashes = new Set(ds.map((d) => d.post_sha256));
  assert.equal(hashes.size, 1, `${P}: the 3 entries disagree on the post hash: ${[...hashes].join(', ')}`);
  const counts = new Set(ds.map((d) => d.post_lines));
  assert.equal(counts.size, 1, `${P}: the 3 entries disagree on the post line count`);

  const buf = fs.readFileSync(EXEC_PATH);
  const actualHash = crypto.createHash('sha256').update(buf).digest('hex');
  assert.equal([...hashes][0], actualHash, `${P}: the ledgered post hash is not the hash on disk`);
  let newlines = 0;
  for (const b of buf) if (b === 0x0a) newlines += 1;
  assert.equal([...counts][0], newlines, `${P}: the ledgered post line count is not the count on disk`);
});

test(`${P}: exactly 1 vendored file diverges and every other pinned file still hashes to its pin`, () => {
  let unchanged = 0;
  let diverged = 0;
  for (const [rel, pin] of Object.entries(MANIFEST.files)) {
    const abs = path.join(VENDOR_ROOT, rel.split('/').join(path.sep));
    const actual = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    if (rel === EXEC_KEY) {
      assert.notEqual(actual, pin.sha256, `${P}: ${rel} is meant to diverge and does not`);
      diverged += 1;
      continue;
    }
    assert.equal(
      actual,
      pin.sha256,
      `${P}: ${rel} drifted from its pristine pin. Only ${EXEC_KEY} may diverge in this phase, ` +
        'and the runner and the maintain entrypoint in particular are untouchable under D1.',
    );
    unchanged += 1;
  }
  assert.equal(diverged, 1, `${P}: ${diverged} files diverge, expected exactly 1`);
  assert.equal(
    unchanged,
    MANIFEST.file_count - 1,
    `${P}: ${unchanged} pinned files are unchanged, expected ${MANIFEST.file_count - 1}. Asserting the ` +
      'COUNT rather than naming the runner and the maintain entrypoint is what stops a third file ' +
      'from diverging unnoticed.',
  );
});

// ─── DIV-01: the supervisor retains a bounded quantity of child output ───────

test(`${P}: DIV-01 the supervisor returns everything on the pristine copy and a bounded tail on the shipped copy`, () => {
  const big = 12000000;
  const pre = drive('supervise', 'pristine', [String(big)]);
  const post = drive('supervise', 'shipped', [String(big)]);

  assert.equal(pre.cap, null, `${P}: the pristine copy already carries a cap, so DIV-01 changes nothing`);
  assert.equal(
    pre.returned,
    pre.wrote,
    `${P}: DIV-01 pristine arm: the supervisor returned ${pre.returned} of ${pre.wrote} bytes. The ` +
      'defect being fixed is that it returns ALL of them, so if this arm does not observe that, the ' +
      'driver is not exercising the unbounded path and the shipped arm below proves nothing.',
  );
  assert.ok(typeof post.cap === 'number' && post.cap > 200000, `${P}: the shipped cap is not above the 200000 both callers slice`);
  assert.ok(
    post.returned <= post.cap,
    `${P}: DIV-01 shipped arm: the supervisor returned ${post.returned} bytes with a cap of ${post.cap}`,
  );
  assert.ok(post.returned < pre.returned, `${P}: DIV-01 shipped arm retained as much as the pristine one`);
  assert.equal(
    post.tail,
    'ZTAILZ',
    `${P}: DIV-01 shipped arm: the retained window is not the child's LAST bytes, so eviction is ` +
      'happening at the wrong end and the callers would read a truncated prefix instead of the tail',
  );
});

test(`${P}: DIV-01 a child under the cap produces byte identical output on both copies`, () => {
  const pre = drive('supervise', 'pristine', ['1000']);
  const post = drive('supervise', 'shipped', ['1000']);
  assert.equal(pre.returned, 1006, `${P}: the pristine copy did not return the small child's full output`);
  assert.equal(
    post.sha256,
    pre.sha256,
    `${P}: DIV-01 identity arm: a child under the cap must produce byte identical output on both ` +
      `copies. Pristine ${pre.sha256}, shipped ${post.sha256}. This is the arm that proves the cap ` +
      'does not alter ordinary runs.',
  );
});

// ─── DIV-02: the containment audit decodes leniently and cannot skip restore ─

test(`${P}: DIV-02 the audit's own call raises on the pristine copy and round trips on the shipped copy`, () => {
  const pre = drive('decode', 'pristine');
  const post = drive('decode', 'shipped');

  assert.ok(
    pre.git_emits_raw_bytes,
    `${P}: DIV-02 decode arm: the stimulus never reached git's output, so neither arm means ` +
      'anything. The undecodable path is planted through the git INDEX because this filesystem ' +
      'refuses to create such a filename on disk.',
  );
  assert.equal(
    pre.raised,
    'UnicodeDecodeError',
    `${P}: DIV-02 pristine arm: _changed_paths did not raise. That call is run_card's containment ` +
      'audit, and it sits BEFORE the .git tamper check and before any restore, so the raise is the ' +
      `whole defect. Observed ${JSON.stringify(pre)}`,
  );
  assert.equal(post.raised, null, `${P}: DIV-02 shipped arm: _changed_paths still raises`);
  assert.ok(
    post.roundtrips,
    `${P}: DIV-02 shipped arm: the decoded path does not map back to the original bytes, so it would ` +
      'not resolve on disk and the symlink escape check at _escapes would look up a name that does ' +
      'not exist. That is exactly why the replace handler was rejected for this fix.',
  );
});

test(`${P}: DIV-02 an audit that throws skips the restore on the pristine copy and cannot on the shipped copy`, () => {
  const pre = drive('audit-throw', 'pristine');
  const post = drive('audit-throw', 'shipped');

  assert.equal(
    pre.raised,
    'RuntimeError',
    `${P}: DIV-02 throw arm pristine: the exception did not propagate out of guarded_suite`,
  );
  assert.equal(
    pre.restore_calls,
    0,
    `${P}: DIV-02 throw arm pristine: the restore ran ${pre.restore_calls} times. It must run 0, ` +
      'because the whole defect is that the audit sits before the restore with no try around it.',
  );
  assert.ok(
    pre.pwned_in_card_tree,
    `${P}: DIV-02 throw arm pristine: the tree was not left dirty, so the skipped restore has no ` +
      `observable. Observed status ${JSON.stringify(pre.card_tree_dirty)}`,
  );

  assert.equal(post.raised, null, `${P}: DIV-02 throw arm shipped: the exception still propagates`);
  assert.ok(
    post.restore_calls >= 1,
    `${P}: DIV-02 throw arm shipped: the restore did not run. The restore is observed through a ` +
      'recorder rather than through the tree, because the shipped copy deletes its throwaway clone ' +
      'and a clean tree would then be explained by the deletion instead.',
  );
  assert.ok(
    post.violations.some((v) => v.includes('containment audit failed')),
    `${P}: DIV-02 throw arm shipped: an audit that could not complete must FAIL CLOSED and be ` +
      `reported as a violation, never reported clean. Observed ${JSON.stringify(post.violations)}`,
  );
  assert.equal(post.ok, false, `${P}: DIV-02 throw arm shipped: a failed audit reported ok`);
  assert.equal(post.pwned_in_card_tree, false, `${P}: DIV-02 throw arm shipped: the suite's write survived`);
});

test(`${P}: DIV-02 the hook survival exploit is observed working, and is defused by the decode fix alone`, () => {
  const pre = drive('hook-survival', 'pristine');
  const mid = drive('hook-survival', 'div02');
  const post = drive('hook-survival', 'shipped');

  for (const [arm, r] of [['pristine', pre], ['div02', mid], ['shipped', post]]) {
    assert.ok(
      r.stimulus_reached_the_index,
      `${P}: hook survival ${arm} arm: the undecodable path never reached the index, so the arm is vacuous`,
    );
  }

  assert.equal(pre.raised, 'UnicodeDecodeError', `${P}: hook survival pristine arm: the audit did not raise`);
  assert.ok(
    pre.canonical_hook_present && pre.canonical_hook_body.includes('RATCHETPWN'),
    `${P}: hook survival pristine arm: the injected post-commit hook did NOT survive in the ` +
      'canonical repository. Presence here is the half that proves the exploit driver works at all, ' +
      `and without it the 2 arms below prove nothing. Observed ${JSON.stringify(pre)}`,
  );

  assert.equal(mid.raised, null, `${P}: hook survival div02 arm: the audit still raises`);
  assert.equal(
    mid.canonical_hook_present,
    false,
    `${P}: hook survival div02 arm: the hook survived on a copy carrying ONLY the decode fix. This ` +
      'arm exists so the exploit cannot be credited to the isolation clone alone.',
  );
  assert.ok(
    mid.violations.length > 0,
    `${P}: hook survival div02 arm: the hook injection was not reported as a containment violation`,
  );

  assert.equal(post.raised, null, `${P}: hook survival shipped arm: the audit still raises`);
  assert.equal(post.canonical_hook_present, false, `${P}: hook survival shipped arm: the hook survived`);
  assert.ok(post.violations.length > 0, `${P}: hook survival shipped arm: no containment violation reported`);
  assert.equal(post.card_tree_dirty, '', `${P}: hook survival shipped arm: the card tree was left dirty`);
});

// ─── DIV-03: neither untrusted path can reach the canonical git directory ────

test(`${P}: DIV-03 a hostile gate suite reaches the canonical git directory on the pristine copy and cannot on the shipped copy`, () => {
  const pre = drive('suite-escape', 'pristine');
  const post = drive('suite-escape', 'shipped');

  assert.ok(
    pre.canonical_artifact_present,
    `${P}: DIV-03 suite arm pristine: the hostile write did NOT land in the canonical git directory. ` +
      'Presence here is what proves the driver reaches the surface at all, so its absence makes the ' +
      `shipped arm meaningless. Observed ${JSON.stringify(pre)}`,
  );
  assert.equal(
    post.canonical_artifact_present,
    false,
    `${P}: DIV-03 suite arm shipped: the hostile write still reached ${post.canonical_artifact_path}`,
  );
  assert.equal(
    post.canonical_status,
    '',
    `${P}: DIV-03 suite arm shipped: the canonical repository's own status is not clean`,
  );
});

test(`${P}: DIV-03 a hostile agent reaches the canonical git directory on the pristine copy, and on the shipped copy its legitimate work still lands`, () => {
  const pre = drive('agent-escape', 'pristine');
  const post = drive('agent-escape', 'shipped');

  assert.equal(pre.verdict, 'clean', `${P}: DIV-03 agent arm pristine: the run did not reach a clean verdict`);
  assert.ok(
    pre.canonical_artifact_present,
    `${P}: DIV-03 agent arm pristine: the agent's write did NOT reach the canonical git directory. ` +
      'run_card is the path phase 19 executes and the one with no ref containment at all, so this ' +
      `arm is the one that matters most. Observed ${JSON.stringify(pre)}`,
  );
  assert.ok(pre.legit_in_card_tree, `${P}: DIV-03 agent arm pristine: the legitimate output never landed`);

  assert.equal(
    post.canonical_artifact_present,
    false,
    `${P}: DIV-03 agent arm shipped: the agent's write still reached ${post.canonical_artifact_path}`,
  );
  assert.equal(post.isolated, true, `${P}: DIV-03 agent arm shipped: the delivery artifact does not record isolation`);
  assert.equal(post.transfer_ok, true, `${P}: DIV-03 agent arm shipped: the transfer back did not succeed`);
  assert.equal(post.verdict, 'clean', `${P}: DIV-03 agent arm shipped: the verdict regressed to ${post.verdict}`);
  assert.ok(
    post.legit_in_card_tree,
    `${P}: DIV-03 agent arm shipped: the agent's LEGITIMATE output is not in the card tree. Without ` +
      'this the isolation could be passing by discarding everything the agent did, which would be a ' +
      'broken engine wearing a security fix.',
  );
  assert.ok(
    post.card_tree_head.includes('legit'),
    `${P}: DIV-03 agent arm shipped: the card branch was not moved onto the agent's commit. ` +
      `Observed head ${JSON.stringify(post.card_tree_head)}`,
  );
});

// ─── no artifact was left under the real vendored tree ──────────────────────

test(`${P}: driving the vendored engine left no bytecode artifact under the real tree`, () => {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === BYTECODE_DIR) found.push(full);
        else walk(full);
        continue;
      }
      if (e.name.endsWith('.pyc')) found.push(full);
    }
  };
  walk(VENDOR_ROOT);
  assert.deepEqual(
    found,
    [],
    `${P}: the vendored tree carries compiled bytecode: ${found.join(', ')}. Every copy this file ` +
      'loads lives in a scratch directory and every child runs with bytecode writing disabled, so ' +
      'an artifact here means something ran the tracked copy in place.',
  );
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
