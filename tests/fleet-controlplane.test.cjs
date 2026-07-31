'use strict';

/**
 * Phase 20 SC3: the execution control plane.
 *
 * The engine is NEVER spawned here. `ensureCard` takes its spawn as a seam and
 * every case drives a stub that writes the card store the real `take` would
 * write, because a suite that mints real git worktrees is a suite nobody runs.
 * The real chain was proven separately and is recorded, with exit codes, in
 * `.planning/phases/20-autonomy-guards/CONTROL-PLANE-PROOF.md`.
 *
 * What IS exercised against real git: `observeTopology` and
 * `assertBranchPointIsCurrent`, both against scratch repositories built in the
 * test. Those 2 read topology, and topology asserted rather than observed is the
 * exact defect (FF-B101) the second of them exists to stop.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cp = require('../scripts/fleet-controlplane.cjs');

const SCRATCH_ROOTS = [];

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-cplane-'));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A repository with a real remote, so `observeTopology` reads something true.
 * The remote is a bare repo on disk, which the manifest loader accepts as an
 * absolute path.
 */
function repoWithRemote() {
  const root = scratch();
  const bare = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  spawnSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'first');
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'fetch', '-q', 'origin');
  return { root, bare, work };
}

// ── remote normalisation ────────────────────────────────────────────────────

test('a github https remote passes through unchanged', () => {
  const url = 'https://github.com/FerroxLabs/ferrox-factory.git';
  assert.equal(cp.normalizeRemoteUrl(url, 'origin'), url);
});

test('an ssh remote is converted, because the loader would refuse it verbatim', () => {
  // `ratchet:94` accepts a github https URL or an absolute path and nothing
  // else, and ssh is the common real world remote that regex rejects.
  assert.equal(
    cp.normalizeRemoteUrl('git@github.com:FerroxLabs/ferrox-factory.git', 'origin'),
    'https://github.com/FerroxLabs/ferrox-factory.git',
  );
  assert.equal(
    cp.normalizeRemoteUrl('ssh://git@github.com/Owner/repo', 'origin'),
    'https://github.com/Owner/repo.git',
  );
});

test('an absolute path passes through, because the loader accepts one', () => {
  assert.equal(cp.normalizeRemoteUrl('/srv/git/thing', 'origin'), '/srv/git/thing');
});

test('anything the loader would refuse is refused HERE, where the message names it', () => {
  for (const bad of ['ftp://example.com/x', 'relative/path', 'https://gitlab.com/a/b.git']) {
    assert.throws(
      () => cp.normalizeRemoteUrl(bad, 'origin'),
      /manifest loader refuses/,
      `${bad} should refuse`,
    );
  }
});

// ── topology, observed ──────────────────────────────────────────────────────

test('the topology is read from git rather than asserted', () => {
  const { bare, work } = repoWithRemote();
  const topo = cp.observeTopology({ repoRoot: work });
  assert.equal(topo.repoPath, work);
  assert.equal(topo.mainline, 'main');
  assert.equal(topo.primary, 'origin');
  assert.equal(topo.remotes.origin, bare);
});

test('a repository with no remote refuses rather than emitting a manifest that cannot work', () => {
  const root = scratch();
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  assert.throws(() => cp.observeTopology({ repoRoot: root }), /has no git remote/);
});

test('the manifest carries every key the engine loader requires', () => {
  const { work } = repoWithRemote();
  const topo = cp.observeTopology({ repoRoot: work });
  const m = cp.buildManifest({ topology: topo, worktreeRoot: '/tmp/wt' });

  assert.equal(m.schema_version, 1);
  const repo = m.repos[cp.REPO_KEY];
  // The required set from `ratchet:84`. Written out rather than looped over a
  // constant, so a key removed from the builder fails here by name.
  for (const key of [
    'path', 'mainline', 'fetch_remote', 'push_remote', 'gh_login', 'remotes', 'worktree_root',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(repo, key), `manifest is missing ${key}`);
  }
  assert.equal(repo.gh_login, cp.GH_LOGIN_LOCAL);
  assert.equal(repo.fetch_remote, 'origin');
});

/**
 * THE SUITE COMMAND IS INJECTABLE, AND THE DEFAULT ARM IS THE ONE WITH TEETH.
 *
 * The land gate runs its suite INSIDE the worker's worktree, which has no
 * installed dependencies, so the shipped constant installs them first. That is
 * the FF-B217 fix and it must stay the default: a proof that drives this chain
 * against a scratch fixture needs to declare a fast suite instead, and a seam
 * added for that reason is a seam by which the real gate can be weakened through
 * OMISSION. An empty command is worse than a slow one: the engine refuses with
 * `no suite_cmd in the manifest` and the whole land aborts.
 *
 * So both halves are asserted. Supplying a value must reach the written manifest,
 * and supplying nothing must produce the exported constant, byte for byte.
 */
test('the suite command defaults to the shipped constant and is NOT weakened by omission', () => {
  const { work } = repoWithRemote();
  const topo = cp.observeTopology({ repoRoot: work });

  const bare = cp.buildManifest({ topology: topo, worktreeRoot: '/tmp/wt' });
  assert.equal(
    bare.repos[cp.REPO_KEY].suite_cmd, cp.SUITE_CMD,
    'an omitted suite command must yield the real gate rather than an empty one',
  );

  // An empty string is the shape an omission takes when it arrives through a
  // variable rather than through an absent argument, and it is the shape that
  // makes the engine refuse. It must be treated as absence, not as a command.
  const blank = cp.buildManifest({ topology: topo, worktreeRoot: '/tmp/wt', suiteCmd: '' });
  assert.equal(blank.repos[cp.REPO_KEY].suite_cmd, cp.SUITE_CMD);

  assert.match(
    cp.SUITE_CMD, /npm ci/,
    'the default must still install before it tests, or FF-B217 returns',
  );
});

test('a supplied suite command reaches the written manifest', () => {
  const { work } = repoWithRemote();
  const home = path.join(scratch(), 'home');
  const declared = 'echo fixture-suite-marker';

  const out = cp.ensureManifest({ repoRoot: work, home, suiteCmd: declared });
  const parsed = JSON.parse(fs.readFileSync(out.manifestPath, 'utf8'));
  assert.equal(
    parsed.repos[cp.REPO_KEY].suite_cmd, declared,
    'the value has to survive all the way to the file the engine reads, not just the object',
  );
  assert.notEqual(
    parsed.repos[cp.REPO_KEY].suite_cmd, cp.SUITE_CMD,
    'and it has to be the supplied one, or the arm would pass on a builder that ignores it',
  );
});

test('ensureManifest writes parseable JSON at the path the engine reads', () => {
  const { work } = repoWithRemote();
  const home = path.join(scratch(), 'home');
  const out = cp.ensureManifest({ repoRoot: work, home });

  assert.equal(out.manifestPath, cp.manifestPath(home));
  const parsed = JSON.parse(fs.readFileSync(out.manifestPath, 'utf8'));
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.repos[cp.REPO_KEY].path, work);
  assert.ok(fs.existsSync(cp.worktreeRootPath(home)), 'the worktree root should exist');
});

// ── the stale base guard. This is the one that matters. ─────────────────────

test('a branch point level with the tree is accepted', () => {
  const { work } = repoWithRemote();
  const topo = cp.observeTopology({ repoRoot: work });
  const base = cp.assertBranchPointIsCurrent({ repoRoot: work, topology: topo });
  assert.equal(base.commits_ahead, 0);
  assert.equal(base.ref, 'origin/main');
});

test('a branch point BEHIND the tree refuses, naming the gap', () => {
  const { work } = repoWithRemote();
  // Commit locally without pushing. This is the live shape of the real repo,
  // which sat 762 commits ahead of origin/main with nothing pushed all
  // milestone. Every worktree would have been cut from the stale ref and every
  // worker would have looked healthy (FF-B101).
  fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'unpushed');

  const topo = cp.observeTopology({ repoRoot: work });
  assert.throws(
    () => cp.assertBranchPointIsCurrent({ repoRoot: work, topology: topo }),
    (err) => {
      assert.match(err.message, /REFUSING to mint cards/);
      assert.match(err.message, /1 commit\(s\) AHEAD/);
      // The remedy must not be "push", unconditionally: pushing is a human's
      // call on this project, 1 push at a time.
      assert.match(err.message, /will never do it/);
      return true;
    },
  );
});

test('a branch point that does not resolve refuses rather than defaulting', () => {
  const { work } = repoWithRemote();
  const topo = cp.observeTopology({ repoRoot: work });
  assert.throws(
    () => cp.assertBranchPointIsCurrent({
      repoRoot: work,
      topology: { ...topo, mainline: 'no-such-branch' },
    }),
    /does not resolve/,
  );
});

// ── cards ───────────────────────────────────────────────────────────────────

/** Write the card store shape the real `take` writes. */
function writeCards(home, cards) {
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(cp.cardsPath(home), JSON.stringify({ schema_version: 1, cards }, null, 1));
}

test('findOpenCard matches on slug, and only when the card is OPEN', () => {
  const open = { work_id: 'aaaa', slug: '20-01', repo: 'core', status: 'open' };
  const closed = { work_id: 'bbbb', slug: '20-02', repo: 'core', status: 'landed' };
  const cards = [open, closed];

  assert.equal(cp.findOpenCard(cards, '20-01'), open);
  // `ratchet-exec:701` requires status open, so a landed card is not a match.
  assert.equal(cp.findOpenCard(cards, '20-02'), null);
  assert.equal(cp.findOpenCard(cards, '20-99'), null);
});

test('ensureCard returns the work id, which is NOT the slug', () => {
  const home = path.join(scratch(), 'home');
  const spawnEngine = () => {
    // What the real `take` does: append an open card whose work_id is a hash.
    writeCards(home, [{
      work_id: '8f5e7a9df1', slug: '20-01', repo: 'core', status: 'open',
      worktree: '/wt/wt-20-01',
    }]);
    return { status: 0, stdout: '', stderr: '' };
  };

  const { card, created } = cp.ensureCard({ home, slug: '20-01', title: 't', spawnEngine });
  assert.equal(created, true);
  // THE NAMESPACE TRAP. Passing the slug to exec refuses with exit 2; this is
  // the value that reaches verdict clean.
  assert.equal(card.work_id, '8f5e7a9df1');
  assert.notEqual(card.work_id, card.slug);
});

test('ensureCard is idempotent, so a re-run does not open a second card per node', () => {
  const home = path.join(scratch(), 'home');
  writeCards(home, [{
    work_id: 'deadbeef', slug: '20-01', repo: 'core', status: 'open', worktree: '/wt/a',
  }]);
  let spawned = 0;
  const spawnEngine = () => { spawned += 1; return { status: 0, stdout: '', stderr: '' }; };

  const { card, created } = cp.ensureCard({ home, slug: '20-01', spawnEngine });
  assert.equal(created, false);
  assert.equal(spawned, 0, 'an existing open card must not spawn take again');
  assert.equal(card.work_id, 'deadbeef');
});

test('a take that leaves no card refuses loudly instead of returning an empty mapping', () => {
  const home = path.join(scratch(), 'home');
  writeCards(home, []);
  const spawnEngine = () => ({ status: 1, stdout: 'nope', stderr: 'boom' });

  assert.throws(
    () => cp.ensureCard({ home, slug: '20-01', spawnEngine }),
    (err) => {
      assert.match(err.message, /left no OPEN card/);
      // The engine's own output is carried, because a wrapper that swallows it
      // makes the real cause unreachable.
      assert.match(err.message, /boom/);
      return true;
    },
  );
});

test('ensureControlPlane maps every node and refuses before minting on a stale base', () => {
  const { work } = repoWithRemote();
  const home = path.join(scratch(), 'home');
  let spawned = 0;
  const spawnEngine = ({ args }) => {
    spawned += 1;
    const slug = args[1];
    const cards = cp.readCards(home);
    cards.push({
      work_id: `id-${slug}`, slug, repo: 'core', status: 'open',
      worktree: path.join(cp.worktreeRootPath(home), `wt-${slug}`),
    });
    writeCards(home, cards);
    return { status: 0, stdout: '', stderr: '' };
  };

  // `acknowledgeHooks` is REQUIRED for any arm that mints. See FF-B493: minting
  // installs a git hook pack into the git common directory, so the plane refuses
  // to reach the engine until the caller names the repository it is changing.
  const out = cp.ensureControlPlane({
    repoRoot: work, home, phase: '20', nodes: ['20-01', '20-02'], spawnEngine,
    acknowledgeHooks: work,
  });
  assert.equal(spawned, 2);
  assert.deepEqual(out.created, ['20-01', '20-02']);
  assert.equal(out.base.commits_ahead, 0);
  assert.equal(out.base.checked, true);
  assert.equal(out.cards['20-01'].work_id, 'id-20-01');
  assert.match(out.cards['20-02'].worktree, /wt-20-02$/);

  // Now go stale, and assert NOTHING is minted rather than that a warning prints.
  fs.writeFileSync(path.join(work, 'c.txt'), 'c\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'unpushed');
  const before = spawned;
  assert.throws(
    () => cp.ensureControlPlane({
      repoRoot: work, home, phase: '20', nodes: ['20-03'], spawnEngine,
      acknowledgeHooks: work,
    }),
    /this tree is 1 commit\(s\) AHEAD of it/,
  );
  assert.equal(spawned, before, 'the stale base must refuse BEFORE any card is minted');
});

test('a refused run leaves NO home, NO manifest and NO card store behind', () => {
  // ─── THE FAILING ARM THIS TASK EXISTS FOR ────────────────────────────────
  //
  // `ensureManifest` used to create the home and write the manifest, and only
  // THEN did `ensureControlPlane` run the stale base check. So a first run
  // against a stale base refused correctly and had already changed the world it
  // was asked to judge. That is side effect before validation, the same shape
  // `committedRemote` records twice in the module it lives in, and it cost a 747
  // commit rebase the last time it went unnoticed.
  //
  // The home here is FRESH, which is what makes this arm different from the one
  // above: that one refuses against a home an earlier successful call created,
  // so it cannot see a write the refusal itself performed.
  const { work } = repoWithRemote();
  const home = path.join(scratch(), 'never-created');
  fs.writeFileSync(path.join(work, 'stale.txt'), 'stale\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'unpushed');

  const spawnEngine = () => { throw new Error('nothing may be minted on a stale base'); };
  assert.throws(
    () => cp.ensureControlPlane({
      repoRoot: work, home, phase: '20', nodes: ['20-01'], spawnEngine,
    }),
    /REFUSING to mint cards/,
  );

  assert.equal(fs.existsSync(home), false, 'the refusal must not have created the ratchet home');
  assert.equal(
    fs.existsSync(cp.manifestPath(home)), false, 'the refusal must not have written a manifest',
  );
  assert.equal(
    fs.existsSync(cp.cardsPath(home)), false, 'the refusal must not have left a card store',
  );
  assert.equal(
    fs.existsSync(cp.worktreeRootPath(home)), false,
    'the refusal must not have created a worktree root',
  );
});

test('a current branch point still writes the manifest and still mints, after the reorder', () => {
  // The reorder moves every write behind every check. This arm exists so that
  // "nothing is written" cannot be satisfied by writing nothing ever.
  const { work } = repoWithRemote();
  const home = path.join(scratch(), 'home');
  const spawnEngine = ({ args }) => {
    const slug = args[1];
    const cards = cp.readCards(home);
    cards.push({
      work_id: `id-${slug}`, slug, repo: 'core', status: 'open',
      worktree: path.join(cp.worktreeRootPath(home), `wt-${slug}`),
    });
    writeCards(home, cards);
    return { status: 0, stdout: '', stderr: '' };
  };

  const out = cp.ensureControlPlane({
    repoRoot: work, home, phase: '20', nodes: ['20-01'], spawnEngine, acknowledgeHooks: work,
  });
  assert.equal(fs.existsSync(cp.manifestPath(home)), true, 'the manifest must be written');
  assert.equal(fs.existsSync(cp.worktreeRootPath(home)), true, 'the worktree root must exist');
  assert.equal(out.base.checked, true);
  assert.deepEqual(out.created, ['20-01']);
});

test('the fleet remote stays STICKY across the reorder, with no environment variable set', () => {
  // FF-B218. The remote used to come from the environment alone, so an
  // unqualified run silently repointed the fleet back to `origin`. The reorder
  // moves the manifest read into the pure phase, and this arm pins that the read
  // still happens and still wins over the default.
  const { root, work } = repoWithRemote();
  const other = path.join(root, 'fleet.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', other]);
  git(work, 'remote', 'add', 'fleet', other);
  git(work, 'push', '-q', 'fleet', 'main');
  git(work, 'fetch', '-q', 'fleet');

  const home = path.join(scratch(), 'home');
  cp.ensureManifest({ repoRoot: work, home, preferRemote: 'fleet' });
  assert.equal(cp.committedRemote(home), 'fleet');

  // No preferRemote, and this suite sets no FERROX_FLEET_REMOTE.
  const out = cp.ensureControlPlane({
    repoRoot: work, home, phase: '20', nodes: [], spawnEngine: () => {
      throw new Error('nothing should be minted for an empty graph');
    },
  });
  assert.equal(out.home, home);
  const parsed = JSON.parse(fs.readFileSync(cp.manifestPath(home), 'utf8'));
  assert.equal(parsed.repos[cp.REPO_KEY].fetch_remote, 'fleet', 'the committed remote must stick');
});

test('an empty graph reports the base check SKIPPED, never green', () => {
  const { work } = repoWithRemote();
  const home = path.join(scratch(), 'home');
  // Go stale on purpose. With 0 nodes there is nothing to cut a worktree from,
  // so the check has no subject; the point is that it must not therefore report
  // a PASS. This project has already shipped a guard that read green while
  // measuring nothing, and "nothing is stale" is vacuously true of an empty
  // graph.
  fs.writeFileSync(path.join(work, 'd.txt'), 'd\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'unpushed');

  const out = cp.ensureControlPlane({
    repoRoot: work, home, phase: '20', nodes: [], spawnEngine: () => {
      throw new Error('nothing should be minted for an empty graph');
    },
  });
  assert.equal(out.base.checked, false);
  assert.equal(out.base.reason, 'no-nodes-to-mint');
  assert.equal(out.base.commits_ahead, null);
  assert.deepEqual(out.created, []);
  // The skip is a skip, not a refusal: the manifest is still written.
  assert.equal(fs.existsSync(cp.manifestPath(home)), true);
});

// ── the shared git hooks, FENCED by observation ─────────────────────────────
//
// `ratchet take` installs its hook pack into the git COMMON directory, so
// minting a work card for a fleet node changes the commit policy of the primary
// tree the operator is typing in. OBSERVED live in this repository on
// 2026-07-27, by driving the installed hooks directly rather than reading them:
// the commit-msg hook exits 1 on a subject of 84 characters and exits 1 on a
// message carrying the AI co-authorship trailer 262 of the last 400 commits in
// this repository's own history use, and the pre-push hook exits 1 on a direct
// push of the mainline and exits 0 for the same input under
// RATCHET_BREAK_GLASS=1.
//
// The decision is FENCE rather than restore: the same hook pack carries the
// mainline push block, which is a protection this project wants, and removing a
// protection to remove a surprise is a poor trade. So the hooks stay and the
// change announces itself. See FF-B219 and FF-B220.

/** A hook directory listing, without touching a real one. */
function stubHookIo(files) {
  return {
    exists: () => true,
    list: () => Object.keys(files),
    digest: (full) => files[path.basename(full)],
  };
}

test('a hook that APPEARED during minting is named in the report', () => {
  const before = cp.observeHooks({ hooksDir: '/h', io: stubHookIo({ 'pre-commit': 'aaa' }) });
  const after = cp.observeHooks({
    hooksDir: '/h', io: stubHookIo({ 'pre-commit': 'aaa', 'commit-msg': 'bbb' }),
  });
  const lines = [];
  const report = cp.reportHookChange({ before, after, warn: (l) => lines.push(l) });

  assert.deepEqual(report.appeared, ['commit-msg']);
  // The unchanged hook must NOT be named. A report that names everything it saw
  // is a listing, not a difference.
  assert.deepEqual(report.modified, []);
  assert.deepEqual(report.removed, []);
  assert.equal(report.changed, 1);
  // Counts, not a bare list. An empty difference with no count is
  // indistinguishable from a check that looked at nothing, and this repository
  // has already shipped that exact defect once.
  assert.equal(report.seen_before, 1);
  assert.equal(report.seen_after, 2);
  assert.equal(report.resolved, true);
  // stderr, so an operator learns about a policy change without parsing JSON.
  assert.equal(lines.length, 1);
  assert.match(lines[0], /commit-msg/);
  assert.match(lines[0], /shared git hooks CHANGED/);
});

test('a hook whose CONTENT changed is named, separately from one that appeared', () => {
  const before = cp.observeHooks({
    hooksDir: '/h', io: stubHookIo({ 'pre-commit': 'aaa', 'pre-push': 'ccc' }),
  });
  const after = cp.observeHooks({
    hooksDir: '/h', io: stubHookIo({ 'pre-commit': 'REWRITTEN', 'pre-push': 'ccc' }),
  });
  const report = cp.reportHookChange({ before, after, warn: () => {} });
  assert.deepEqual(report.modified, ['pre-commit']);
  assert.deepEqual(report.appeared, []);
  assert.equal(report.changed, 1);
});

test('an unchanged hook directory reports 0 changed AND a non zero count seen', () => {
  const io = stubHookIo({ 'pre-commit': 'aaa', 'commit-msg': 'bbb' });
  const before = cp.observeHooks({ hooksDir: '/h', io });
  const after = cp.observeHooks({ hooksDir: '/h', io });
  const lines = [];
  const report = cp.reportHookChange({ before, after, warn: (l) => lines.push(l) });
  assert.equal(report.changed, 0);
  assert.equal(report.seen_before, 2, 'a clean verdict must say how much it looked at');
  assert.equal(report.seen_after, 2);
  assert.equal(lines.length, 0, 'an unchanged run must not shout');
});

test('the hooks directory is resolved from git-common-dir, not assumed to be .git/hooks', () => {
  // A linked worktree has its own git directory and a COMMON one, and the hooks
  // live in the common one. That is exactly why this side effect reaches the
  // primary tree at all, so assuming `.git/hooks` would fence the wrong path.
  const { work } = repoWithRemote();
  const dir = cp.resolveHooksDir({ repoRoot: work });
  assert.equal(dir, path.join(work, '.git', 'hooks'));
  assert.equal(fs.existsSync(dir), true);
});

test('ensureControlPlane NAMES a hook a real mint installed into the shared dir', () => {
  // The fixture ADDS a hook between the 2 observations. A hook observation that
  // has only ever run over an unchanging directory has never been seen detecting
  // anything, and this phase exists to remove exactly that shape.
  const { work } = repoWithRemote();
  const home = path.join(scratch(), 'home');
  const spawnEngine = ({ args }) => {
    const slug = args[1];
    // What `ratchet take` does at `ratchet:703`: write its hook pack into the
    // directory `git rev-parse --git-common-dir` reports.
    fs.writeFileSync(path.join(work, '.git', 'hooks', 'commit-msg'), '#!/usr/bin/env bash\n');
    const cards = cp.readCards(home);
    cards.push({
      work_id: `id-${slug}`, slug, repo: 'core', status: 'open',
      worktree: path.join(cp.worktreeRootPath(home), `wt-${slug}`),
    });
    writeCards(home, cards);
    return { status: 0, stdout: '', stderr: '' };
  };

  const lines = [];
  const out = cp.ensureControlPlane({
    repoRoot: work, home, phase: '20', nodes: ['20-01'], spawnEngine, warn: (l) => lines.push(l),
    acknowledgeHooks: work,
  });

  assert.deepEqual(out.hooks.appeared, ['commit-msg']);
  assert.equal(out.hooks.changed, 1);
  assert.ok(out.hooks.seen_before > 0, 'the report must say how many hook files it saw');
  assert.equal(out.hooks.seen_after, out.hooks.seen_before + 1);
  assert.equal(out.hooks.dir, path.join(work, '.git', 'hooks'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /commit-msg/);
});

test('a run that mints no card reports an empty difference over a non zero count', () => {
  const { work } = repoWithRemote();
  const home = path.join(scratch(), 'home');
  const lines = [];
  const out = cp.ensureControlPlane({
    repoRoot: work,
    home,
    phase: '20',
    nodes: [],
    spawnEngine: () => { throw new Error('nothing should be minted for an empty graph'); },
    warn: (l) => lines.push(l),
  });
  assert.equal(out.hooks.changed, 0);
  assert.equal(out.hooks.resolved, true);
  // A fresh `git init` ships its sample hooks, so this count is genuinely non
  // zero and the clean verdict is over a real payload.
  assert.ok(out.hooks.seen_before > 0, 'a clean hook verdict must carry what it looked at');
  assert.equal(lines.length, 0);
});

// ── the fleet remote ────────────────────────────────────────────────────────

test('the fleet remote is configurable, because origin is not always the fleet base', () => {
  const { root, work } = repoWithRemote();
  // `take` cuts from <fetch_remote>/<mainline> and `land` pushes to
  // <push_remote>, so this 1 name decides both. A repository whose origin lags
  // the tree, which this project does by 765 commits, has to point the fleet
  // somewhere else.
  const other = path.join(root, 'fleet.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', other]);
  git(work, 'remote', 'add', 'fleet', other);

  const topo = cp.observeTopology({ repoRoot: work, preferRemote: 'fleet' });
  assert.equal(topo.primary, 'fleet');

  const m = cp.buildManifest({ topology: topo, worktreeRoot: '/tmp/wt' });
  assert.equal(m.repos[cp.REPO_KEY].fetch_remote, 'fleet');
  assert.equal(m.repos[cp.REPO_KEY].push_remote, 'fleet');
});

test('a fleet remote that does not exist refuses HERE, not as a REMOTES RED rollback', () => {
  const { work } = repoWithRemote();
  assert.throws(
    () => cp.observeTopology({ repoRoot: work, preferRemote: 'no-such-remote' }),
    /is not a remote of/,
  );
});

test('with no fleet remote configured the behaviour is unchanged', () => {
  const { work } = repoWithRemote();
  assert.equal(cp.observeTopology({ repoRoot: work }).primary, 'origin');
});

// ── the gh identity ─────────────────────────────────────────────────────────

test('a github fleet remote declares the identity gh will actually act as', () => {
  // `ratchet:258` compares the manifest's gh_login against the live gh account
  // and reports a mismatch, and land pushes a branch plus opens a PR as that
  // identity. A hardcoded value would either warn forever or name an account
  // that cannot write to the remote.
  const execGh = () => ({ status: 0, stdout: 'FerroxLabs\n', stderr: '' });
  assert.equal(
    cp.resolveGhLogin({ remoteUrl: 'https://github.com/FerroxLabs/x.git', execGh }),
    'FerroxLabs',
  );
});

test('a path fleet remote declares local, because it has no github identity', () => {
  const execGh = () => { throw new Error('gh must not be consulted for a path remote'); };
  assert.equal(cp.resolveGhLogin({ remoteUrl: '/srv/mirror.git', execGh }), cp.GH_LOGIN_LOCAL);
});

test('a github remote with no usable gh identity REFUSES rather than warning later', () => {
  // The fleet lands by opening a pull request. Dispatching workers whose work
  // can never land is the failure this refusal exists to stop.
  const execGh = () => ({ status: 1, stdout: '', stderr: 'not logged in' });
  assert.throws(
    () => cp.resolveGhLogin({ remoteUrl: 'https://github.com/FerroxLabs/x.git', execGh }),
    /could never land/,
  );
});

// ── the operations document, checked against the scripts ────────────────────
//
// A document written once rots. This battery reads the 2 fleet scripts, extracts
// every environment variable they touch, extracts the variable names the
// operations document declares, and refuses when a variable is touched and not
// documented. Adding a new environment read to either script without documenting
// it turns the suite red, which is what makes the document a check rather than
// prose nobody updated.
//
// Both vacuous passes are refused EXPLICITLY. An extraction that finds 0 table
// rows throws, a scan that finds 0 script files throws, and a scan that finds 0
// variables throws. A clean verdict over an empty payload is not a clean
// verdict, and a regular expression that quietly stops matching produces exactly
// that shape.

const OPS_DOC = path.join(__dirname, '..', 'docs', 'reference', 'fleet-operations.md');
const FLEET_SCRIPTS = [
  path.join(__dirname, '..', 'scripts', 'fleet-controlplane.cjs'),
  path.join(__dirname, '..', 'scripts', 'fleet-loop.cjs'),
];

/** The 3 variables the ENGINE reads, which no scan of this repository can find. */
const ENGINE_VARS = ['RATCHET_HOME', 'RATCHET_BREAK_GLASS', 'RATCHET_MOCK_CMD'];

/**
 * The variable names the document's table declares.
 *
 * A row is a table line whose first cell is a backticked all capitals name, which
 * is specific enough that ordinary prose in the same file cannot be mistaken for
 * a declaration.
 */
function documentedVars(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const row = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/.exec(line);
    if (row !== null) names.add(row[1]);
  }
  if (names.size === 0) {
    throw new Error(
      'the operations document declares 0 environment variables. An agreement check over an '
        + 'empty table passes for every possible script, which is not a pass.',
    );
  }
  return names;
}

/**
 * Every environment variable either script touches, by file.
 *
 * Four patterns, each written down rather than inferred:
 *   1. `process.env.NAME`            a read
 *   2. `process.env['NAME']`         a read
 *   3. `env.NAME =`                  a write onto a child environment object
 *   4. a key in an object literal that spreads `process.env`, which is how both
 *      scripts set the engine's variables on a child
 */
function scannedVars(files, readText) {
  if (files.length === 0) {
    throw new Error(
      'the environment scan found 0 script files. "Nothing undocumented" is vacuously true of a '
        + 'scan with no subject, and a moved or renamed script produces exactly that.',
    );
  }
  const found = new Map();
  for (const file of files) {
    const text = readText(file);
    const names = new Set();
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
    for (const m of text.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) {
      names.add(m[1]);
    }
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\s*=[^=]/g)) names.add(m[1]);
    for (const spread of text.matchAll(/\.\.\.process\.env\s*,([^}]*)\}/g)) {
      for (const key of spread[1].matchAll(/([A-Z][A-Z0-9_]*)\s*:/g)) names.add(key[1]);
    }
    for (const name of names) {
      if (!found.has(name)) found.set(name, []);
      found.get(name).push(path.basename(file));
    }
  }
  if (found.size === 0) {
    throw new Error(
      'the environment scan found 0 variables across the fleet scripts. Both scripts do touch '
        + 'the environment, so an empty result means the patterns stopped matching.',
    );
  }
  return found;
}

test('every environment variable the fleet scripts touch is documented', () => {
  const documented = documentedVars(fs.readFileSync(OPS_DOC, 'utf8'));
  const scanned = scannedVars(FLEET_SCRIPTS, (f) => fs.readFileSync(f, 'utf8'));

  const undocumented = [];
  for (const [name, files] of scanned) {
    if (!documented.has(name)) undocumented.push(`${name} (read by ${files.join(', ')})`);
  }
  assert.deepEqual(
    undocumented, [],
    `undocumented environment variables: ${undocumented.join('; ')}. `
      + `Add a row to ${path.relative(path.join(__dirname, '..'), OPS_DOC)}.`,
  );
  // The scan is over a real payload, so the clean verdict above means something.
  assert.ok(scanned.size >= 3, `the scan found only ${scanned.size} variable(s)`);
});

test('an undocumented read turns the check RED, naming the file and the variable', () => {
  // The failing arm. A check that has only ever run over a compliant tree has
  // never been seen refusing anything.
  const documented = documentedVars(fs.readFileSync(OPS_DOC, 'utf8'));
  const synthetic = '/synthetic/fleet-invented.cjs';
  const scanned = scannedVars(
    [synthetic],
    () => 'const x = process.env.FERROX_UNDOCUMENTED_KNOB;\n',
  );

  const undocumented = [...scanned]
    .filter(([name]) => !documented.has(name))
    .map(([name, files]) => `${name} (read by ${files.join(', ')})`);
  assert.equal(undocumented.length, 1);
  assert.match(undocumented[0], /FERROX_UNDOCUMENTED_KNOB/);
  assert.match(undocumented[0], /fleet-invented\.cjs/);
});

test('the child environment writes are scanned, not only the reads', () => {
  // `engineEnv` sets its variables as keys of an object literal that spreads
  // `process.env`, and a scanner that only matched reads would see neither. Those
  // 2 are the variables an operator most needs named.
  const scanned = scannedVars(FLEET_SCRIPTS, (f) => fs.readFileSync(f, 'utf8'));
  for (const name of ['RATCHET_HOME', 'PYTHONDONTWRITEBYTECODE', 'FERROX_FLEET_REMOTE']) {
    assert.ok(scanned.has(name), `${name} should have been found by the scan`);
  }
});

test('an extraction that finds 0 table rows THROWS rather than passing', () => {
  assert.throws(
    () => documentedVars('# Fleet operations\n\nNo table here at all.\n'),
    /declares 0 environment variables/,
  );
  // A table whose first cell is not a backticked name is not a declaration
  // either, so a reformat that breaks the extraction is caught rather than
  // silently emptying the documented set.
  assert.throws(
    () => documentedVars('| variable | what |\n|---|---|\n| RATCHET_HOME | the home |\n'),
    /declares 0 environment variables/,
  );
});

test('a scan that finds 0 script files THROWS rather than passing', () => {
  assert.throws(
    () => scannedVars([], () => ''),
    /found 0 script files/,
  );
});

test('a scan that finds 0 variables THROWS rather than reporting nothing undocumented', () => {
  assert.throws(
    () => scannedVars(['/synthetic/empty.cjs'], () => '// no environment here\n'),
    /found 0 variables/,
  );
});

test('the 3 engine variables an operator must know about are each documented', () => {
  // These are read by the vendored engine, so no scan of this repository can
  // find them. The list is explicit on purpose: adding a fourth is a 1 line
  // edit, which is the point of not deriving it from a tree this repository
  // does not author.
  const documented = documentedVars(fs.readFileSync(OPS_DOC, 'utf8'));
  for (const name of ENGINE_VARS) {
    assert.ok(documented.has(name), `${name} must appear in the operations table`);
  }
  // The break glass escape is the one that is operationally required and was
  // written down nowhere, so its row must say what it unblocks.
  const text = fs.readFileSync(OPS_DOC, 'utf8');
  assert.match(text, /RATCHET_BREAK_GLASS/);
  assert.match(text, /direct push to the mainline/i);
});

// ── the engine environment ──────────────────────────────────────────────────

test('every engine child gets a repo scoped home and no bytecode writing', () => {
  const env = cp.engineEnv('/somewhere/.ferrox/ratchet-home');
  assert.equal(env.RATCHET_HOME, '/somewhere/.ferrox/ratchet-home');
  // The vendored tree is byte pinned and 5 guards assert it carries no
  // bytecode. Running the fleet must not mutate the engine it runs.
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
});

// ════════════════════════════════════════════════════════════════════════════
// FF-B491, FF-B492, FF-B493: what the worker is told, and who consented to it
// ════════════════════════════════════════════════════════════════════════════

/**
 * ─── THE ONE THING THAT IS STUBBED HERE, AND WHY ─────────────────────────────
 *
 * `build_brief` below is the REAL one, loaded out of a byte identical copy of
 * the vendored engine. The plan file is a REAL file on disk. `phase-plan-index`
 * is the REAL shipped verb. The only stub is `ratchet take` itself, because
 * this file's opening comment commits to never spawning the engine and a suite
 * that mints real git worktrees is a suite nobody runs.
 *
 * The stub is faithful to `ratchet:1748-1749` and `ratchet:1778`, which read
 * `--title` and `--issue` off argv and store them on the card under those
 * names, and it derives both from the ACTUAL argv rather than from constants,
 * so a change that stopped passing them turns these arms red.
 *
 * The FULL chain, with the real `ratchet take` minting a real worktree against
 * a scratch fixture and the real `build_brief` reading the resulting card, was
 * driven live on 2026-07-29 while writing this. Both the before and the after
 * briefs are quoted verbatim in the phase report.
 */

const ENGINE_BIN = path.join(
  __dirname, '..', 'ferrox-core', 'bin', 'vendor', 'ratchet', 'bin',
);

const PYTHON_PROBE = spawnSync('python3', ['-c', 'pass'], { encoding: 'utf8' });
const SKIP_NO_PYTHON = (PYTHON_PROBE.error || PYTHON_PROBE.status !== 0)
  ? 'python3 is not runnable on this machine, and the vendored engine entrypoints are python3'
  : false;

/**
 * A scratch COPY of the engine's 2 entrypoints.
 *
 * The repository's own copy is NEVER imported. `ratchet-exec` loads the kernel
 * as a library out of its own directory, and an import writes bytecode beside
 * the source unless the interpreter was started with -B. 5 guards assert the
 * pinned tree carries no bytecode, so this file works from a copy AND passes -B.
 * Belt and braces, because the failure mode is 5 unrelated tests going red.
 */
function engineCopy() {
  const dir = path.join(scratch(), 'engine');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['ratchet', 'ratchet-exec']) {
    fs.copyFileSync(path.join(ENGINE_BIN, name), path.join(dir, name));
  }
  return dir;
}

/** Compose the REAL brief for a minted card, with the engine's own composer. */
function realBrief({ home, slug, engineDir }) {
  const script = path.join(scratch(), 'compose.py');
  fs.writeFileSync(script, [
    'import importlib.machinery, importlib.util, json, os, sys',
    'HOME, SLUG, ENGINE = sys.argv[1], sys.argv[2], sys.argv[3]',
    'os.environ["RATCHET_HOME"] = HOME',
    'spec = importlib.util.spec_from_loader("ratchet_exec",',
    '    importlib.machinery.SourceFileLoader("ratchet_exec",',
    '        os.path.join(ENGINE, "ratchet-exec")))',
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'cards = json.load(open(os.path.join(HOME, "state", "workcards.json")))["cards"]',
    'card = next(c for c in cards if c["slug"] == SLUG)',
    'm = json.load(open(os.path.join(HOME, "state", "workspace.json")))',
    'sys.stdout.write(mod.build_brief(m, card, m["repos"][card["repo"]]))',
  ].join('\n'));

  const proc = spawnSync('python3', ['-B', script, home, slug, engineDir], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(proc.status, 0, `composing the real brief failed: ${proc.stderr}`);
  return proc.stdout;
}

/**
 * A repository carrying a REAL phase directory with a REAL plan file.
 *
 * The write lane is declared in the plan's own frontmatter and read back
 * through the shipped `phase-plan-index` verb, so these arms assert on what a
 * plan actually says rather than on a value this file also wrote by hand.
 */
const FIXTURE_LANE = Object.freeze(['src/fixture-alpha.cts', 'tests/fixture-alpha.test.cjs']);
const FIXTURE_OBJECTIVE = 'Wire the fixture alpha seam and prove the brief carries it.';

function repoWithPhase({ planId = '30-01', phaseDir = '30-fixture' } = {}) {
  const built = repoWithRemote();
  const dir = path.join(built.work, '.planning', 'phases', phaseDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${planId}-PLAN.md`), [
    '---',
    'phase: 30',
    `plan: ${planId}`,
    'wave: 1',
    'depends_on: []',
    'autonomous: true',
    'files_modified:',
    ...FIXTURE_LANE.map((f) => `  - ${f}`),
    '---',
    '',
    '# Fixture',
    '',
    '<objective>',
    FIXTURE_OBJECTIVE,
    '</objective>',
  ].join('\n'));
  git(built.work, 'add', '-A');
  git(built.work, 'commit', '-q', '-m', 'plan');
  git(built.work, 'push', '-q', 'origin', 'main');
  git(built.work, 'fetch', '-q', 'origin');
  return { ...built, planRelative: `.planning/phases/${phaseDir}/${planId}-PLAN.md` };
}

/**
 * The stub `take`, faithful to `ratchet:1748-1749` and `ratchet:1778`.
 *
 * It COUNTS, and the count is the subject of the consent arms. A refusal flag
 * alone passes for an implementation that reports a refusal and mints anyway,
 * which is the exact defect shape this project keeps shipping.
 */
function countingEngine(home) {
  const calls = [];
  const spawnEngine = ({ args }) => {
    calls.push(args);
    const at = (flag) => (args.indexOf(flag) === -1 ? '' : args[args.indexOf(flag) + 1]);
    const slug = args[1];
    const cards = cp.readCards(home);
    cards.push({
      work_id: `id-${slug}`,
      slug,
      repo: at('--repo') || 'core',
      title: at('--title') || slug,
      issue: at('--issue'),
      risk: 'normal',
      status: 'open',
      worktree: path.join(cp.worktreeRootPath(home), `wt-${slug}`),
    });
    writeCards(home, cards);
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, spawnEngine };
}

// ── FF-B491: the brief names the work ───────────────────────────────────────

test('the composed brief NAMES the plan file, the objective and every lane path', {
  skip: SKIP_NO_PYTHON,
}, () => {
  const { work, planRelative } = repoWithPhase();
  const home = path.join(scratch(), 'home');
  const { calls, spawnEngine } = countingEngine(home);

  const out = cp.ensureControlPlane({
    repoRoot: work,
    home,
    phase: '30',
    nodes: ['30-01'],
    spawnEngine,
    acknowledgeHooks: work,
    env: {},
  });

  // ── NON VACUITY FIRST ────────────────────────────────────────────────────
  // Every containment assertion below is vacuously true of an empty list, so
  // the list is proven non empty BEFORE it is searched for, and it is proven
  // non empty from what the plane READ rather than from the constant this file
  // also wrote.
  const lane = out.briefs['30-01'].files_modified;
  assert.ok(lane.length > 0, 'the write lane read from the plan must not be empty');
  assert.deepEqual(lane, [...FIXTURE_LANE], 'the lane must be what the plan declares');
  assert.equal(out.briefs['30-01'].plan_path, planRelative);
  assert.equal(out.briefs['30-01'].objective, FIXTURE_OBJECTIVE);

  // ── THE BRIEF ITSELF, composed by the engine's own build_brief ────────────
  const brief = realBrief({ home, slug: '30-01', engineDir: engineCopy() });

  assert.ok(
    brief.includes(planRelative),
    `the brief must NAME the plan file. It said:\n${brief}`,
  );
  for (const file of lane) {
    assert.ok(brief.includes(file), `the brief must name the lane path ${file}`);
  }
  assert.ok(brief.includes(FIXTURE_OBJECTIVE), 'the brief must carry the objective');

  // The path has to be usable from INSIDE the worktree, so it is repo relative.
  // An absolute path would point the worker at the primary tree it must not
  // touch, and it would still satisfy a naive "contains the plan" assertion.
  assert.equal(path.isAbsolute(out.briefs['30-01'].plan_path), false);

  // And the engine really did receive the channel.
  const args = calls[0];
  assert.ok(args.includes('--issue'), '`take` must be given the brief as the issue');
  const issue = args[args.indexOf('--issue') + 1];
  assert.ok(issue.startsWith(planRelative), 'the bare plan path must be the first line');
  assert.match(issue, /READ THAT FILE FIRST/, 'the pointer must be imperative, not a label');
});

test('the brief used to be 4 words, and this arm fails if it goes back to being 4 words', () => {
  const { work, planRelative } = repoWithPhase();
  const home = path.join(scratch(), 'home');
  const { calls, spawnEngine } = countingEngine(home);

  cp.ensureControlPlane({
    repoRoot: work, home, phase: '30', nodes: ['30-01'], spawnEngine,
    acknowledgeHooks: work, env: {},
  });

  // What this module used to mint, verbatim. Observed on 2026-07-29 against a
  // real card composed by the engine's own build_brief:
  //     title: phase 30 30-01
  //     issue: none
  // and nothing else. 4 words, for the whole of what the worker was told.
  const args = calls[0];
  assert.notEqual(args.indexOf('--issue'), -1, '`take` used to be given no --issue at all');
  const told = args[args.indexOf('--issue') + 1];
  assert.ok(told.includes(planRelative), 'the worker must be told which plan to build');
  assert.ok(told.includes('src/fixture-alpha.cts'), 'and which files it may touch');
});

/**
 * THE TITLE IS AN INPUT TO A SECURITY BOUNDARY, SO IT DID NOT CHANGE.
 *
 * `ratchet-index:388` computes the exec sandbox's WRITE MANIFEST from
 * `_keywords(card["title"] + " " + card["slug"])`. The first build of the brief
 * enrichment put the plan path and the write lane into the title, and 3 real
 * dispatches in `tests/fleet-land-proof.test.cjs` came back
 * `exec: REJECTED, out-of-lane write` because the index confidently scoped the
 * lane to the PLAN's own directory. A brief that tells an agent what to build
 * while revoking its permission to build it is worse than no brief.
 *
 * This arm drives the ENGINE'S OWN keyword extractor over both titles and pins
 * that the sets are identical, because "the title is unchanged" is exactly the
 * kind of claim that rots into a comment.
 */
test('the composed card title feeds compute_grant EXACTLY what it always did', {
  skip: SKIP_NO_PYTHON,
}, () => {
  const brief = cp.composeCardBrief({
    phase: '30',
    nodeId: '30-01',
    planPath: '.planning/phases/30-fixture/30-01-PLAN.md',
    objective: FIXTURE_OBJECTIVE,
    filesModified: [...FIXTURE_LANE],
  });
  assert.equal(brief.title, 'phase 30 30-01');

  const engineDir = engineCopy();
  fs.copyFileSync(path.join(ENGINE_BIN, 'ratchet-index'), path.join(engineDir, 'ratchet-index'));
  const script = path.join(scratch(), 'kw.py');
  fs.writeFileSync(script, [
    'import importlib.machinery, importlib.util, json, os, sys',
    'ENGINE = sys.argv[1]',
    'spec = importlib.util.spec_from_loader("ratchet_index",',
    '    importlib.machinery.SourceFileLoader("ratchet_index",',
    '        os.path.join(ENGINE, "ratchet-index")))',
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'sys.stdout.write(json.dumps({t: sorted(mod._keywords(t + " 30-01"))',
    '    for t in json.loads(sys.argv[2])}))',
  ].join('\n'));

  const titles = ['phase 30 30-01', brief.title];
  const proc = spawnSync('python3', ['-B', script, engineDir, JSON.stringify(titles)], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(proc.status, 0, `driving the engine's own _keywords failed: ${proc.stderr}`);
  const keywords = JSON.parse(proc.stdout);

  assert.deepEqual(
    keywords[brief.title], keywords['phase 30 30-01'],
    'the enriched card must not widen or narrow the exec sandbox grant',
  );
  // NON VACUITY: an extractor that returned nothing at all would make the
  // comparison above pass for any pair of titles whatsoever.
  assert.ok(keywords[brief.title].length > 0, 'the keyword set under test must not be empty');

  // And the payload really is somewhere the grant matcher never reads.
  assert.ok(brief.issue.includes('.planning/phases/30-fixture/30-01-PLAN.md'));
  for (const file of FIXTURE_LANE) assert.ok(brief.issue.includes(file));
  assert.equal(brief.title.includes('.planning'), false, 'no path may enter the grant input');
});

test('a node with NO plan file says so, rather than quietly carrying 4 words', () => {
  const { work } = repoWithRemote();
  const home = path.join(scratch(), 'home');
  const { spawnEngine } = countingEngine(home);

  const out = cp.ensureControlPlane({
    repoRoot: work, home, phase: '30', nodes: ['30-01'], spawnEngine,
    acknowledgeHooks: work, env: {},
  });

  const brief = out.briefs['30-01'];
  assert.equal(brief.plan_path, null);
  // It SAYS so, rather than falling back to the engine's bare `issue: none`,
  // which is indistinguishable from a value somebody forgot to set.
  assert.match(brief.issue, /NO PLAN FILE WAS LOCATED/);
  assert.match(brief.issue, /no phase directory tree was readable/);
  assert.equal(brief.title, 'phase 30 30-01', 'the grant input is unchanged either way');
  assert.equal(out.brief_source.briefed, 0);
  assert.equal(out.brief_source.unbriefed, 1);
});

test('2 phase directories carrying the same plan name REFUSE to guess', () => {
  const located = cp.locatePlanFile({
    repoRoot: '/repo',
    phase: '',
    nodeId: '30-01',
    io: {
      readdirSync: () => [
        { name: '30-a', isDirectory: () => true },
        { name: '30-b', isDirectory: () => true },
      ],
      existsSync: () => true,
    },
  });
  assert.equal(located.path, null, 'a brief pointing at the WRONG plan is worse than none');
  assert.match(located.reason, /2 phase directories/);
});

test('an ambiguous plan name is resolved by the phase when the phase singles one out', () => {
  const located = cp.locatePlanFile({
    repoRoot: '/repo',
    phase: '30',
    nodeId: '30-01',
    io: {
      readdirSync: () => [
        { name: '30-fixture', isDirectory: () => true },
        { name: '31-other', isDirectory: () => true },
      ],
      existsSync: () => true,
    },
  });
  assert.equal(located.path, path.join('.planning', 'phases', '30-fixture', '30-01-PLAN.md')
    .split(path.sep).join('/'));
});

test('an empty write lane is NAMED as empty, never rendered as a lane of 0 paths', () => {
  const brief = cp.composeCardBrief({
    phase: '30', nodeId: '30-01', planPath: 'p/30-01-PLAN.md', filesModified: [],
  });
  assert.match(brief.issue, /declares no files_modified/);
  assert.deepEqual(brief.files_modified, []);
});

// ── FF-B492: the repo identity is a parameter, end to end ───────────────────

test('an explicitly passed suite command reaches the BRIEF the worker reads', {
  skip: SKIP_NO_PYTHON,
}, () => {
  const { work } = repoWithPhase();
  const home = path.join(scratch(), 'home');
  const { spawnEngine } = countingEngine(home);
  const RUST = 'cargo nextest run --workspace';

  cp.ensureControlPlane({
    repoRoot: work, home, phase: '30', nodes: ['30-01'], spawnEngine,
    acknowledgeHooks: work, env: {}, suiteCmd: RUST,
  });

  // The manifest is already covered above. This asserts the value survives all
  // the way to the text the AGENT reads, which is the only place it matters:
  // `build_brief` prints `suite (must stay green)` from `r['suite_cmd']`.
  const brief = realBrief({ home, slug: '30-01', engineDir: engineCopy() });
  assert.ok(brief.includes(RUST), `the brief must carry the declared suite. It said:\n${brief}`);
  assert.equal(brief.includes(cp.SUITE_CMD), false, 'the npm default must not leak through');
});

test('a non default repo key reaches the MANIFEST, not only the take argv', () => {
  // The parameter used to be threaded to `ensureCard` and not to `planManifest`,
  // so the manifest was written under `repos.core` while `take` was invoked with
  // `--repo <the caller's key>`. The engine then refuses with `unknown repo`. A
  // parameter wired to 1 of its 3 consumers reads as configurable and is not.
  const { work } = repoWithRemote();
  const home = path.join(scratch(), 'home');
  const { calls, spawnEngine } = countingEngine(home);

  const out = cp.ensureControlPlane({
    repoRoot: work, home, phase: '30', nodes: ['30-01'], repoKey: 'waylandcore',
    spawnEngine, acknowledgeHooks: work, env: {},
  });

  const manifest = JSON.parse(fs.readFileSync(cp.manifestPath(home), 'utf8'));
  assert.deepEqual(Object.keys(manifest.repos), ['waylandcore']);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest.repos, cp.REPO_KEY), false);
  assert.equal(calls[0][calls[0].indexOf('--repo') + 1], 'waylandcore');
  assert.equal(out.repo_key, 'waylandcore');
  // And the card was actually found, which it would not be under a mismatch.
  assert.equal(out.cards['30-01'].work_id, 'id-30-01');
});

test('the STICKY fleet remote sticks under a non default repo key too', () => {
  // `committedRemote` read the module constant rather than the parameter, so on
  // any other key the read missed, the sticky remote silently stopped sticking
  // and the fleet reset to `origin`. That is FF-B218 arriving through a 2nd door.
  const { root, work } = repoWithRemote();
  const other = path.join(root, 'fleet.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', other]);
  git(work, 'remote', 'add', 'fleet', other);
  git(work, 'push', '-q', 'fleet', 'main');
  git(work, 'fetch', '-q', 'fleet');

  const home = path.join(scratch(), 'home');
  cp.ensureManifest({ repoRoot: work, home, repoKey: 'waylandcore', preferRemote: 'fleet' });

  assert.equal(cp.committedRemote(home, 'waylandcore'), 'fleet');
  // The unqualified read is the one that used to be taken. It finds nothing,
  // which is precisely why passing the key matters.
  assert.equal(cp.committedRemote(home), null);

  const out = cp.ensureControlPlane({
    repoRoot: work, home, phase: '30', nodes: [], repoKey: 'waylandcore',
    spawnEngine: () => { throw new Error('nothing should be minted for an empty graph'); },
    env: {},
  });
  assert.equal(out.repo_key, 'waylandcore');
  const parsed = JSON.parse(fs.readFileSync(cp.manifestPath(home), 'utf8'));
  assert.equal(parsed.repos.waylandcore.fetch_remote, 'fleet', 'the committed remote must stick');
});

test('the engine resolves from the FERROX install, never from the target repo', () => {
  // OBSERVED: driving the plane against a scratch fixture spawned
  // `<fixture>/ferrox-core/bin/vendor/ratchet/bin/ratchet` and died ENOENT,
  // because the engine path was built from `repoRoot`. A Rust workspace vendors
  // no ratchet, so pointing the fleet at one could never have worked.
  const seen = [];
  const spawnSyncStub = { calls: seen };
  void spawnSyncStub;
  assert.equal(cp.FERROX_ROOT, path.resolve(__dirname, '..'));
  // The default is the install root and NOT whatever repo a caller names.
  assert.notEqual(cp.FERROX_ROOT, '/some/other/repo');
  // And `ensureCard` forwards it, so a caller can point at a relocated install.
  let engineRootSeen = null;
  const home = path.join(scratch(), 'home');
  cp.ensureCard({
    home,
    repoRoot: '/some/other/repo',
    engineRoot: '/opt/ferrox',
    slug: '30-01',
    title: 't',
    spawnEngine: ({ engineRoot }) => {
      engineRootSeen = engineRoot;
      const cards = cp.readCards(home);
      cards.push({
        work_id: 'id', slug: '30-01', repo: 'core', status: 'open', worktree: 'wt',
      });
      fs.mkdirSync(path.join(home, 'state'), { recursive: true });
      writeCards(home, cards);
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(engineRootSeen, '/opt/ferrox');
});

// ── FF-B493: the hook pack consent gate ─────────────────────────────────────

test('minting without acknowledgement REFUSES, and mints EXACTLY 0 cards', () => {
  const { work } = repoWithPhase();
  const home = path.join(scratch(), 'home');
  const { calls, spawnEngine } = countingEngine(home);

  // The code path is proven REACHED and proven to produce a refusal FIRST.
  assert.throws(
    () => cp.ensureControlPlane({
      repoRoot: work, home, phase: '30', nodes: ['30-01'], spawnEngine, env: {},
    }),
    /REFUSING to mint cards: minting runs `ratchet take`/,
  );

  // THE COUNTER, and it is the assertion that matters. A refusal flag alone
  // passes for an implementation that reports a refusal and mints anyway.
  assert.equal(calls.length, 0, 'not one engine card-minting invocation may have happened');
  // And nothing was written, so the refusal left no state a later run reads as
  // a decision somebody made.
  assert.equal(fs.existsSync(home), false, 'a refused run must leave no home behind');
});

test('the refusal NAMES every hook, where it goes, and what it does', () => {
  const { work } = repoWithPhase();
  const home = path.join(scratch(), 'home');
  let message = '';
  try {
    cp.ensureControlPlane({
      repoRoot: work, home, phase: '30', nodes: ['30-01'], env: {},
      spawnEngine: () => { throw new Error('unreachable'); },
    });
  } catch (err) {
    message = String(err.message);
  }
  assert.notEqual(message, '', 'the guard must actually refuse');
  for (const hook of cp.HOOK_PACK) {
    assert.ok(message.includes(hook), `the refusal must name ${hook}`);
  }
  assert.ok(message.includes(cp.HOOK_ACK_ENV), 'it must say how to acknowledge');
  assert.ok(message.includes(work), 'it must name the repository it is protecting');
  assert.match(message, /72 characters/, 'it must say what the hooks actually do');
  assert.match(message, /RATCHET_BREAK_GLASS/);
  assert.match(message, /every worktree of this repository/i);
});

test('acknowledgement lets minting through, so the guard is not a permanent no', () => {
  const { work } = repoWithPhase();
  const home = path.join(scratch(), 'home');
  const { calls, spawnEngine } = countingEngine(home);

  const out = cp.ensureControlPlane({
    repoRoot: work, home, phase: '30', nodes: ['30-01'], spawnEngine,
    acknowledgeHooks: work, env: {},
  });

  assert.ok(calls.length > 0, 'an acknowledged mint must actually mint');
  assert.equal(calls.length, 1);
  assert.equal(out.hook_ack.acknowledged, true);
  assert.equal(out.hook_ack.checked, true);
  assert.equal(out.hook_ack.source, 'parameter');
});

test('the environment channel acknowledges, and only the repo it NAMES', () => {
  const { work } = repoWithPhase();
  const home = path.join(scratch(), 'home');
  const { calls, spawnEngine } = countingEngine(home);

  const out = cp.ensureControlPlane({
    repoRoot: work, home, phase: '30', nodes: ['30-01'], spawnEngine,
    env: { [cp.HOOK_ACK_ENV]: work },
  });
  assert.equal(calls.length, 1);
  assert.equal(out.hook_ack.source, 'environment');
});

test('acknowledging repo A does NOT authorize minting into repo B', () => {
  const a = repoWithRemote().work;
  const { work } = repoWithPhase();
  const home = path.join(scratch(), 'home');
  const { calls, spawnEngine } = countingEngine(home);

  assert.throws(
    () => cp.ensureControlPlane({
      repoRoot: work, home, phase: '30', nodes: ['30-01'], spawnEngine,
      acknowledgeHooks: a, env: { [cp.HOOK_ACK_ENV]: a },
    }),
    /REFUSING to mint cards/,
  );
  assert.equal(calls.length, 0, 'consent for one repository is not consent for another');
});

test('a bare truthy environment value is NOT an acknowledgement', () => {
  // `=1` would acknowledge every repository the process ever touches, which is
  // the blanket consent this gate exists to refuse.
  for (const value of ['1', 'true', 'yes']) {
    const verdict = cp.resolveHookAck({
      repoRoot: '/repo/a', env: { [cp.HOOK_ACK_ENV]: value },
    });
    assert.equal(verdict.acknowledged, false, `${value} must not acknowledge anything`);
  }
});

test('an acknowledgement list acknowledges each repository it names, and no other', () => {
  const list = ['/repo/a', '/repo/b'].join(path.delimiter);
  assert.equal(cp.resolveHookAck({ repoRoot: '/repo/a', env: { [cp.HOOK_ACK_ENV]: list } })
    .acknowledged, true);
  assert.equal(cp.resolveHookAck({ repoRoot: '/repo/b', env: { [cp.HOOK_ACK_ENV]: list } })
    .acknowledged, true);
  assert.equal(cp.resolveHookAck({ repoRoot: '/repo/c', env: { [cp.HOOK_ACK_ENV]: list } })
    .acknowledged, false);
});

test('a graph with 0 nodes installs 0 hooks, so the gate reports SKIPPED not green', () => {
  // "Nothing was installed" is vacuously true of a run that mints nothing, and
  // this project has already shipped a guard that reported green while
  // measuring nothing. A caller must be able to tell the 2 apart.
  const { work } = repoWithRemote();
  const home = path.join(scratch(), 'home');
  const out = cp.ensureControlPlane({
    repoRoot: work, home, phase: '30', nodes: [], env: {},
    spawnEngine: () => { throw new Error('nothing should be minted for an empty graph'); },
  });
  assert.equal(out.hook_ack.checked, false);
  assert.equal(out.hook_ack.acknowledged, false);
  assert.equal(out.hook_ack.reason, 'no-cards-to-mint');
});
