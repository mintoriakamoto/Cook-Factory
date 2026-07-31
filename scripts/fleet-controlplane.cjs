#!/usr/bin/env node
'use strict';

/**
 * Phase 20 SC3: the fleet's execution control plane.
 *
 * The first real dispatch of `scripts/fleet-loop.cjs --run` spawned 32 workers
 * and all 32 refused with `exec: no OPEN card <id>`. The worker seam was right;
 * the control plane it assumed did not exist anywhere in this repository. See
 * FF-B215 and `.planning/phases/20-autonomy-guards/CONTROL-PLANE-PROOF.md`,
 * which records the whole chain as it was RUN rather than as it reads.
 *
 * This module builds the 4 things that were missing, and nothing else:
 *
 *   1. a repo scoped ratchet home, so a run depends on nothing outside this
 *      repository. The engine resolves `RATCHET_HOME`, then `WL_HOME`, then
 *      `~/.ratchet` (`ratchet:35`), and this project set none of them, so a
 *      fleet run silently borrowed the operator's personal state.
 *   2. a topology manifest, generated from OBSERVED git topology.
 *   3. a work card per workgraph node.
 *   4. the node id to work id mapping the worker seam needs.
 *
 * ─── THE NAMESPACE TRAP, WHICH IS THE WHOLE BUG ──────────────────────────────
 *
 * `ratchet-exec:701` matches a card on `c["work_id"]`, a content hash. The card
 * also carries a `slug`, which is what `take` was given and what a workgraph
 * node id maps onto. THEY ARE DIFFERENT VALUES. Passing the slug refuses with
 * exit 2; passing the work id reaches verdict clean. Both arms were run. So the
 * mapping this module returns is not a convenience, it is the fix.
 *
 * ─── WHY NOTHING HERE PARSES `take` OUTPUT ───────────────────────────────────
 *
 * `take` prints the work id in a prose line decorated with the engine's own
 * punctuation. THE PRODUCER IS THE AUTHORITY: the card store at
 * `<home>/state/workcards.json` is the value `exec` itself reads, so this module
 * reads that and never the prose. A parser over a human sentence would drift the
 * first time upstream reworded it, and it would drift silently.
 *
 * Usage:
 *   node scripts/fleet-controlplane.cjs <phase>           # ensure, print the mapping
 *   node scripts/fleet-controlplane.cjs <phase> --raw     # the same, on 1 line
 *
 * Flags, all optional, all defaulting to the self hosted case:
 *   --repo-root <path>   the repository the fleet BUILDS. Not where Ferrox is.
 *   --repo-key <key>     the manifest key for it. Default `core`.
 *   --suite-cmd <cmd>    the land gate's suite command. Default `npm ...`.
 *   --ack-hooks          acknowledge the git hook pack for --repo-root. See
 *                        assertHookPackAcknowledged: minting installs hooks into
 *                        the git COMMON directory, so it refuses without this.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { ExitError, runMain, withWayOut } = require('./lib/cli-exit.cjs');

/**
 * WHERE FERROX ITSELF IS INSTALLED. Not the repository the fleet builds.
 *
 * ─── WHY THESE ARE 2 CONSTANTS AND USED TO BE 1 (FF-B491) ────────────────────
 *
 * `path.resolve(__dirname, '..')` answers exactly 1 question: where does this
 * script live. That is the FERROX install, and it is where the vendored engine
 * and `ferrox-tools.cjs` are found. It was ALSO used as the target repository,
 * which is true only for the self hosted case and silently false for every
 * other one.
 *
 * OBSERVED, not reasoned: driving `ensureControlPlane({repoRoot: <a scratch
 * fixture>})` spawned
 * `<fixture>/ferrox-core/bin/vendor/ratchet/bin/ratchet` and died ENOENT,
 * because `defaultSpawnEngine` resolved the engine under the TARGET repo. A
 * 56 crate Rust workspace vendors no ratchet, so pointing the fleet at one
 * could never have worked. The engine now resolves from `engineRoot`, whose
 * default is this constant, and `repoRoot` means the target repository and
 * nothing else.
 */
const FERROX_ROOT = path.resolve(__dirname, '..');

/**
 * The DEFAULT target repository, which is a fallback and never an authority.
 *
 * Every entry point takes `repoRoot` as a parameter. This value is what an
 * omitted parameter falls back to, so the self hosted case keeps working. A
 * caller that names a repository gets that repository end to end.
 */
const REPO_ROOT = FERROX_ROOT;

/** The engine entrypoints, relative to the FERROX install root. */
const RATCHET_ENTRYPOINT = ['ferrox-core', 'bin', 'vendor', 'ratchet', 'bin', 'ratchet'];

/** The shipped verb runner, relative to the FERROX install root. */
const FERROX_TOOLS_ENTRYPOINT = ['ferrox-core', 'bin', 'ferrox-tools.cjs'];

/**
 * The DEFAULT repo key the manifest declares, which is a fallback, never a law.
 *
 * ─── WHY THIS BEING A CONSTANT WAS A BUG (FF-B492) ───────────────────────────
 *
 * `ensureControlPlane` accepted `repoKey` and passed it to `ensureCard`, so the
 * parameter LOOKED wired. It was not: `planManifest` never forwarded it, so
 * `buildManifest` fell back to this literal and wrote the manifest under
 * `repos.core` while `take` was invoked with `--repo <the caller's key>`. The
 * engine then refuses with `take: unknown repo`. `committedRemote` read this
 * literal too, so on any other key the FF-B218 stickiness silently stopped
 * working and the fleet remote reset to `origin`.
 *
 * That is the exact shape the parameter audit exists to catch: an argument
 * threaded to 1 of its 3 consumers reads as configurable and is not.
 */
const REPO_KEY = 'core';

/**
 * The `gh_login` used when the fleet remote is NOT a GitHub repository.
 *
 * A path remote has no GitHub identity to act as, and inventing one would make
 * `ratchet doctor` compare the live `gh` account against a name that describes
 * nothing.
 */
const GH_LOGIN_LOCAL = 'local';

/**
 * The land gate's suite command.
 *
 * ─── WHY THIS IS DECLARED RATHER THAN DETECTED (FF-B217) ─────────────────────
 *
 * Left undeclared, `detect_repo_check` (`ratchet:787`) finds the `test` script
 * and runs a bare `npm test` inside the worker's worktree. A fresh worktree has
 * NO `node_modules`, so `pretest` cannot run `build:lib`, so the built libs
 * under `ferrox-core/bin/lib/` are absent, because they are gitignored per file
 * and therefore are not part of a checkout. Every test that loads one then
 * fails, and the land gate aborts on a tree that is fine.
 *
 * Measured: 9 failures under the land gate against 0 in the primary tree, in
 * exactly 2 clusters, both of which need a built lib.
 *
 * `npm ci` is the honest fix rather than sharing the primary tree's
 * `node_modules`, because a worker's worktree that borrows the primary tree's
 * dependencies is not isolated, and isolation is the property the whole engine
 * exists to provide. It costs an install per land; the alternative costs the
 * meaning of the gate.
 */
const SUITE_CMD = 'npm ci --no-audit --no-fund && npm test';

/**
 * The identity `gh` will actually act as, or null.
 *
 * DERIVED, never asserted, for the same reason the topology is. `ratchet:258`
 * compares this exact value against the manifest's `gh_login` and reports a
 * mismatch, and `ratchet:768` prints `gh_login must be <x> for writes`. A
 * hardcoded login would therefore either warn forever or, worse, name an
 * account that cannot push to the fleet remote.
 */
function effectiveGhLogin(execGh = defaultExecGh) {
  const proc = execGh(['api', 'user', '--jq', '.login']);
  if (proc.status !== 0) return null;
  const login = String(proc.stdout).trim();
  return /^[A-Za-z0-9-]+$/.test(login) ? login : null;
}

function defaultExecGh(args) {
  const proc = spawnSync('gh', args, { encoding: 'utf8' });
  if (proc.error !== undefined && proc.error !== null) return { status: 1, stdout: '', stderr: '' };
  return { status: proc.status, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/**
 * The login to declare for a fleet remote.
 *
 * A GitHub remote needs the account that can WRITE to it, because `land` pushes
 * a branch there and opens a pull request. A path remote gets `local`.
 */
function resolveGhLogin({ remoteUrl, execGh = defaultExecGh } = {}) {
  if (!String(remoteUrl).startsWith('https://github.com/')) return GH_LOGIN_LOCAL;
  const login = effectiveGhLogin(execGh);
  if (login === null) {
    throw new ExitError(
      1,
      `the fleet remote ${JSON.stringify(String(remoteUrl))} is a GitHub repository, and `
        + '`gh` reports no usable identity. The fleet lands by pushing a branch and opening a '
        + 'pull request, so a run would dispatch workers whose work could never land. Run '
        + '`gh auth login` first.',
    );
  }
  return login;
}

/**
 * The environment every spawned engine process gets.
 *
 * `PYTHONDONTWRITEBYTECODE` is not optional. The vendored tree is byte pinned
 * and 5 guards assert it carries no bytecode; a bare interpreter invocation
 * against it turned 8 suite tests red the first time the fleet dispatched.
 * RUNNING THE FLEET MUST NOT MUTATE THE ENGINE IT RUNS.
 */
function engineEnv(home) {
  return { ...process.env, RATCHET_HOME: home, PYTHONDONTWRITEBYTECODE: '1' };
}

/** The repo scoped home. `.ferrox` is already gitignored at `.gitignore:49`. */
function ratchetHomePath(repoRoot) {
  return path.join(repoRoot, '.ferrox', 'ratchet-home');
}

function manifestPath(home) {
  return path.join(home, 'state', 'workspace.json');
}

function cardsPath(home) {
  return path.join(home, 'state', 'workcards.json');
}

function worktreeRootPath(home) {
  return path.join(home, 'worktrees');
}

/**
 * Put a git remote URL into a form the manifest loader accepts.
 *
 * `ratchet:94` requires `https://github.com/<owner>/<repo>[.git]` or an ABSOLUTE
 * path, and refuses anything else. An SSH remote is the common real world case
 * that regex rejects, so it is converted rather than left to fail deep inside a
 * verb. Anything still unrecognised REFUSES here, where the message can name the
 * remote, instead of surfacing later as a REMOTES RED rollback.
 */
function normalizeRemoteUrl(url, remoteName) {
  const raw = String(url).trim();
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(raw)) return raw;
  if (path.isAbsolute(raw)) return raw;

  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(raw);
  if (ssh !== null) return `https://github.com/${ssh[1]}/${ssh[2]}.git`;

  throw new ExitError(
    1,
    `the git remote ${JSON.stringify(remoteName)} is ${JSON.stringify(raw)}, which the engine's `
      + 'manifest loader refuses: it accepts a github https URL or an absolute path, and this is '
      + 'neither. Declaring it anyway produces a REMOTES RED rollback inside `take` rather than a '
      + 'message naming the remote.',
  );
}

function defaultExecGit(args, opts = {}) {
  const proc = spawnSync('git', args, { encoding: 'utf8', ...opts });
  if (proc.error !== undefined && proc.error !== null) throw proc.error;
  return { status: proc.status, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/**
 * Read the repository's real topology.
 *
 * OBSERVED, never asserted. The manifest's declared remote is checked against
 * the repository's actual configured remote, and a mismatch refuses the verb
 * with `REMOTES RED ... fix topology first`, so a hardcoded URL here would be a
 * guard that fires on a false premise.
 */
function observeTopology({ repoRoot = REPO_ROOT, execGit = defaultExecGit, preferRemote } = {}) {
  const at = (args) => execGit(['-C', repoRoot, ...args]);

  const remotesRaw = at(['remote']);
  if (remotesRaw.status !== 0) {
    throw new ExitError(1, `git remote failed in ${repoRoot}: ${remotesRaw.stderr.trim()}`);
  }
  const names = remotesRaw.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '');
  if (names.length === 0) {
    throw new ExitError(
      1,
      `${repoRoot} has no git remote, and the engine's manifest requires at least 1 plus a `
        + 'fetch_remote and a push_remote naming it. A fleet cannot branch off a mainline that '
        + 'no remote defines.',
    );
  }

  const remotes = {};
  for (const name of names) {
    const url = at(['remote', 'get-url', name]);
    if (url.status !== 0) continue;
    remotes[name] = normalizeRemoteUrl(url.stdout.trim(), name);
  }

  // The remote the FLEET builds on, which is not always `origin`.
  //
  // `take` cuts every worktree from `<fetch_remote>/<mainline>` and `land`
  // pushes back to `<push_remote>`, so this 1 name decides both the base the
  // fleet builds on and where its work goes. A project whose `origin` lags the
  // working tree, which is this one by 765 commits, needs to point the fleet at
  // a remote that tracks the tree instead. Configurable, and defaulting to
  // `origin` so nothing changes for a project where they are the same.
  const requested = (typeof preferRemote === 'string' && preferRemote !== '')
    ? preferRemote
    : (process.env.FERROX_FLEET_REMOTE ?? '');
  if (requested !== '') {
    if (!Object.prototype.hasOwnProperty.call(remotes, requested)) {
      throw new ExitError(
        1,
        `the fleet remote ${JSON.stringify(requested)} is not a remote of ${repoRoot}. `
          + `Configured remotes: ${Object.keys(remotes).join(', ') || 'none'}. The engine checks `
          + 'the manifest against the repository\'s real remotes and refuses a mismatch, so '
          + 'declaring an absent remote produces a REMOTES RED rollback rather than this line.',
      );
    }
  }
  const primary = requested !== ''
    ? requested
    : (Object.prototype.hasOwnProperty.call(remotes, 'origin') ? 'origin' : names[0]);

  // The mainline as the REMOTE reports it, falling back to the checked out
  // branch. `origin/HEAD` is the remote's own answer and is preferred to a local
  // branch name that happens to be current.
  let mainline = null;
  const head = at(['symbolic-ref', '--short', `refs/remotes/${primary}/HEAD`]);
  if (head.status === 0) {
    const short = head.stdout.trim();
    const slash = short.indexOf('/');
    if (slash !== -1) mainline = short.slice(slash + 1);
  }
  if (mainline === null || mainline === '') {
    const current = at(['symbolic-ref', '--short', 'HEAD']);
    mainline = current.status === 0 ? current.stdout.trim() : '';
  }
  if (mainline === '') {
    throw new ExitError(1, `could not determine the mainline branch of ${repoRoot}`);
  }

  return { repoPath: repoRoot, mainline, remotes, primary };
}

/**
 * The manifest object, in the shape `ratchet:69-99` validates.
 *
 * Every key below is REQUIRED by that loader and its absence is a hard exit, so
 * this function is the single place the required set is written down.
 */
function buildManifest({ repoKey = REPO_KEY, topology, worktreeRoot, ghLogin, suiteCmd }) {
  // THE DEFAULT IS THE REAL GATE. An omitted argument must yield `SUITE_CMD`,
  // never an empty command and never a detected one: `detect_repo_check` is what
  // FF-B217 records failing, and an empty string would make the engine refuse
  // with `no suite_cmd in the manifest` rather than run anything. A test fixture
  // that wants a fast declared suite passes one; a caller that forgets gets the
  // gate this repository actually ships. An arm asserts exactly that, because a
  // seam whose omission weakens a gate is a seam that eventually does.
  const suite = (typeof suiteCmd === 'string' && suiteCmd !== '') ? suiteCmd : SUITE_CMD;
  return {
    schema_version: 1,
    min_ratchet: '0',
    repos: {
      [repoKey]: {
        path: topology.repoPath,
        mainline: topology.mainline,
        fetch_remote: topology.primary,
        push_remote: topology.primary,
        gh_login: ghLogin ?? GH_LOGIN_LOCAL,
        remotes: topology.remotes,
        worktree_root: worktreeRoot,
        // FF-B217. See SUITE_CMD: a detected bare `npm test` runs without
        // node_modules and fails on a tree that is fine.
        suite_cmd: suite,
      },
    },
  };
}

/**
 * The fleet remote a previously written manifest already committed to, or null.
 *
 * ─── WHY THE CHOICE IS STICKY (FF-B218) ──────────────────────────────────────
 *
 * The remote used to come from the environment alone, so ANY invocation without
 * `FERROX_FLEET_REMOTE` silently rewrote the manifest back to `origin`. Observed
 * live: 1 unqualified run repointed the fleet from `dev` to `origin`, and the
 * next land tried to rebase 747 commits onto a tree with almost no shared
 * history and aborted on conflicts. The manifest is written before anything
 * validates it, so a run that later refused had already done the damage.
 *
 * A base this important must not be reset by forgetting an environment
 * variable. An explicit `preferRemote`, or the environment, still overrides it;
 * absence no longer does.
 */
function committedRemote(home, repoKey = REPO_KEY) {
  const target = manifestPath(home);
  if (!fs.existsSync(target)) return null;
  try {
    const repo = JSON.parse(fs.readFileSync(target, 'utf8')).repos?.[repoKey];
    const name = repo?.fetch_remote;
    return typeof name === 'string' && name !== '' ? name : null;
  } catch {
    return null;
  }
}

/**
 * PHASE 1, PURE READS. Everything the manifest needs, and not 1 byte written.
 *
 * ─── WHY THE READ AND THE WRITE ARE 2 FUNCTIONS ──────────────────────────────
 *
 * This module used to create the home and write the manifest, and only THEN did
 * `ensureControlPlane` run the stale base check. So a first run against a stale
 * base refused correctly and had ALREADY changed the world it was asked to
 * judge: the home existed, the manifest was on disk, and a later reader could
 * not tell a refusal from a success.
 *
 * That is side effect before validation, and it is the THIRD instance of that
 * exact shape in this file's own history. `committedRemote` below records the
 * other 2, and the second of them cost a 747 commit rebase before anybody
 * noticed. The class is fixed the way the class demands: VALIDATE, THEN WRITE.
 *
 * The dependency that makes the split non obvious, written down so the next
 * reader does not have to rediscover it: the fleet remote is STICKY, and
 * `committedRemote` reads it out of a manifest that may not exist yet. That is
 * fine and it stays here in the pure phase, because `committedRemote` returns
 * null for an absent manifest and falls through to the `origin` default exactly
 * as it did on a first run. The RESOLUTION ORDER is unchanged. Only the write
 * moved.
 */
function planManifest({
  repoRoot = REPO_ROOT, home, execGit = defaultExecGit, preferRemote, execGh = defaultExecGh,
  suiteCmd, repoKey = REPO_KEY,
} = {}) {
  const target = home ?? ratchetHomePath(repoRoot);
  const worktreeRoot = worktreeRootPath(target);

  // Explicit wins, then the environment, then whatever the manifest already
  // committed to. Only a first run falls through to the `origin` default.
  //
  // `repoKey` is passed to `committedRemote` rather than left to its default.
  // See REPO_KEY: reading the literal here made the sticky remote a no-op for
  // any repository this project does not happen to be, and a stickiness that
  // silently stops sticking is FF-B218 arriving through a second door.
  const effectiveRemote = (typeof preferRemote === 'string' && preferRemote !== '')
    ? preferRemote
    : (process.env.FERROX_FLEET_REMOTE || committedRemote(target, repoKey) || undefined);
  const topology = observeTopology({ repoRoot, execGit, preferRemote: effectiveRemote });
  const ghLogin = resolveGhLogin({ remoteUrl: topology.remotes[topology.primary], execGh });
  const manifest = buildManifest({ repoKey, topology, worktreeRoot, ghLogin, suiteCmd });
  return {
    home: target,
    worktreeRoot,
    topology,
    manifest,
    repoKey,
    manifestPath: manifestPath(target),
  };
}

/** PHASE 2, THE WRITES. Nothing here decides anything. Idempotent. */
function writeManifest(planned) {
  fs.mkdirSync(path.join(planned.home, 'state'), { recursive: true });
  fs.mkdirSync(planned.worktreeRoot, { recursive: true });
  fs.writeFileSync(planned.manifestPath, `${JSON.stringify(planned.manifest, null, 2)}\n`);
  return { home: planned.home, manifest: planned.manifest, manifestPath: planned.manifestPath };
}

/**
 * Create the home and write the manifest. Idempotent, and safe to re-run.
 *
 * Kept as 1 verb for callers that want the manifest and nothing else. A caller
 * that also validates must use `planManifest` and `writeManifest` separately, so
 * that its refusals land before this function's first `mkdirSync`.
 */
function ensureManifest(options = {}) {
  return writeManifest(planManifest(options));
}

/**
 * REFUSE when the branch point `take` would use is behind the working tree.
 *
 * ─── WHY THIS EXISTS AND WHY IT IS NOT ADVISORY ──────────────────────────────
 *
 * `ratchet take` reports `branch feat/<slug> off FRESH origin/main`. It means
 * it: the worktree is cut from the FETCH REMOTE's mainline, not from local HEAD.
 * Measured on this repository at the time it was written, `origin/main` was
 * `748e2ee` and HEAD was 762 commits ahead, because this milestone has pushed
 * nothing. A fleet minted here would have built every node against a tree
 * missing the entire milestone, and every worker would have looked healthy.
 *
 * That is precisely FF-B101: a guard that fires GREEN on a false premise is
 * worse than no guard, because the caller stops looking. Phase 18 fixed it for
 * the preflight's own worktrees by OBSERVING the base. This is the same defect
 * arriving through a different door, so it gets the same treatment: observed,
 * and fatal.
 *
 * It is deliberately not a warning. A warning on a 762 commit gap is a line of
 * output nobody reads before an overnight run.
 */
function assertBranchPointIsCurrent({ repoRoot = REPO_ROOT, topology, execGit = defaultExecGit }) {
  const ref = `${topology.primary}/${topology.mainline}`;
  const at = (args) => execGit(['-C', repoRoot, ...args]);

  const resolved = at(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (resolved.status !== 0) {
    throw new ExitError(
      1,
      `${ref} does not resolve in ${repoRoot}, and that is the ref every worktree would be `
        + 'cut from. A fleet cannot branch off a base that does not exist.',
    );
  }

  const behind = at(['rev-list', '--count', `${ref}..HEAD`]);
  if (behind.status !== 0) {
    throw new ExitError(1, `could not compare HEAD against ${ref}: ${behind.stderr.trim()}`);
  }
  const count = Number(behind.stdout.trim());
  if (!Number.isFinite(count)) {
    throw new ExitError(1, `could not read a commit count from ${JSON.stringify(behind.stdout)}`);
  }
  if (count === 0) return { ref, commits_ahead: 0 };

  throw new ExitError(
    1,
    `REFUSING to mint cards: every worktree would be cut from ${ref}, and this tree is `
      + `${count} commit(s) AHEAD of it. The fleet would build the whole phase against a base `
      + 'missing that work, and every worker would look healthy while doing it (FF-B101).\n\n'
      + 'Resolve it by 1 of:\n'
      + `  - push, so ${ref} matches this tree. Pushing is authorized by a human, 1 push at a `
      + 'time, and this tool will never do it.\n'
      + `  - point the manifest's fetch_remote at a remote whose ${topology.mainline} IS this `
      + 'tree, if you want the fleet to build on unpushed work.\n\n'
      + `HEAD ${at(['rev-parse', '--short', 'HEAD']).stdout.trim()}, `
      + `${ref} ${at(['rev-parse', '--short', ref]).stdout.trim()}.`,
  );
}

// ── the shared git hooks, FENCED rather than removed ────────────────────────

/**
 * ─── THE SIDE EFFECT THIS FENCE EXISTS FOR ───────────────────────────────────
 *
 * `ratchet take` does not only mint a card. `install_hooks` at `ratchet:690`
 * resolves `git rev-parse --git-common-dir` and writes a 3 hook pack there, so
 * minting a work card for a fleet node changes the commit policy of the PRIMARY
 * TREE the operator is typing in. The common directory is shared by every
 * worktree of the repository, which is precisely why the effect crosses out of
 * the fleet's own worktrees.
 *
 * OBSERVED in this repository on 2026-07-27, by driving the installed hooks
 * rather than by reading them: the commit-msg hook exits 1 on a subject longer
 * than 72 characters and exits 1 on a message carrying the AI co-authorship
 * trailer that 262 of the last 400 commits in this repository's own history
 * use, and the pre-push hook exits 1 on a direct push of the mainline while the
 * identical input exits 0 under `RATCHET_BREAK_GLASS=1`.
 *
 * ─── KEEP, FENCE OR RESTORE. THE DECISION IS FENCE ───────────────────────────
 *
 * RESTORE, meaning uninstall the pack after each `take`, was rejected: it means
 * fighting the engine on every mint, and the same pack carries the mainline push
 * block at `ratchet:642`. That block is a protection this project WANTS, and
 * removing a protection to remove a surprise is a poor trade.
 *
 * KEEP AS IS was rejected for the reason the residual was filed at all. A tool
 * that changes the operator's commit policy as a byproduct of a different verb,
 * silently, is the same shape as every other defect this phase removes.
 *
 * FENCE keeps the hooks and makes the change impossible to miss: the directory
 * is observed before minting and after, and every file that appeared, changed or
 * vanished is named, on the returned object AND on stderr. The operator learns
 * about a policy change from the tool that caused it, at the moment it happens.
 *
 * The report carries COUNTS as well as names. An empty difference reported
 * alongside a non zero count of files seen is honest; an empty difference with
 * no count is indistinguishable from a check that looked at nothing, and this
 * repository has already shipped that exact defect in its lint chain.
 */
const defaultHookIo = {
  exists: (target) => fs.existsSync(target),
  list: (target) => fs.readdirSync(target),
  digest: (target) => crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
};

function defaultWarn(line) {
  process.stderr.write(`${line}\n`);
}

/**
 * The hooks directory, resolved from the git COMMON directory.
 *
 * Never assumed to be `.git/hooks`: a linked worktree has its own git directory
 * AND a common one, the hooks live in the common one, and assuming the per
 * worktree path would fence a directory the engine never writes to.
 */
function resolveHooksDir({ repoRoot = REPO_ROOT, execGit = defaultExecGit } = {}) {
  const proc = execGit(['-C', repoRoot, 'rev-parse', '--git-common-dir']);
  if (proc.status !== 0) return null;
  const common = String(proc.stdout).trim();
  if (common === '') return null;
  return path.join(path.isAbsolute(common) ? common : path.join(repoRoot, common), 'hooks');
}

/**
 * A digest per file in the hooks directory.
 *
 * Nothing is filtered out. A filter that drops entries is the silent shrinking
 * subject set this phase exists to remove, and an entry that cannot be read is
 * kept under a sentinel digest rather than dropped, so it still counts and a
 * later change to it still shows.
 */
function observeHooks({ hooksDir, io = defaultHookIo } = {}) {
  if (typeof hooksDir !== 'string' || hooksDir === '') {
    return { dir: null, resolved: false, count: 0, digests: {} };
  }
  if (!io.exists(hooksDir)) return { dir: hooksDir, resolved: true, count: 0, digests: {} };

  const digests = {};
  for (const name of [...io.list(hooksDir)].sort()) {
    let digest;
    try {
      digest = io.digest(path.join(hooksDir, name));
    } catch {
      digest = 'unreadable';
    }
    digests[name] = digest;
  }
  return { dir: hooksDir, resolved: true, count: Object.keys(digests).length, digests };
}

function hookChangeLine(report) {
  const parts = [];
  if (report.appeared.length > 0) parts.push(`appeared: ${report.appeared.join(', ')}`);
  if (report.modified.length > 0) parts.push(`modified: ${report.modified.join(', ')}`);
  if (report.removed.length > 0) parts.push(`removed: ${report.removed.join(', ')}`);
  return 'fleet control plane: the shared git hooks CHANGED during this run. '
    + `dir ${report.dir}, ${report.seen_before} file(s) before, ${report.seen_after} after, `
    + `${report.changed} changed. ${parts.join('; ')}. `
    + 'The engine installs its hook pack into the git COMMON directory, so this governs every '
    + 'commit in the primary tree, not only the fleet\'s worktrees. '
    + 'Inspect them with: git config --get core.hooksPath, then list that directory. '
    + 'Undo the run with /ferrox-undo, or check the project with /ferrox-health.';
}

/** The difference between 2 observations, by name and by count. */
function reportHookChange({ before, after, warn = defaultWarn } = {}) {
  const had = (obs, name) => Object.prototype.hasOwnProperty.call(obs.digests, name);
  const beforeNames = Object.keys(before.digests);
  const afterNames = Object.keys(after.digests);

  const appeared = afterNames.filter((n) => !had(before, n)).sort();
  const removed = beforeNames.filter((n) => !had(after, n)).sort();
  const modified = afterNames
    .filter((n) => had(before, n) && before.digests[n] !== after.digests[n])
    .sort();

  const report = {
    dir: after.dir ?? before.dir ?? null,
    resolved: before.resolved === true && after.resolved === true,
    seen_before: before.count,
    seen_after: after.count,
    appeared,
    modified,
    removed,
    changed: appeared.length + modified.length + removed.length,
  };
  if (report.changed > 0) warn(hookChangeLine(report));
  return report;
}

// ── the hook pack CONSENT GATE, in front of the engine ──────────────────────

/**
 * The 3 hooks `install_hooks` (`ratchet:690`) writes into the git COMMON dir.
 *
 * Named rather than counted, because a refusal that says "some hooks" tells an
 * operator nothing they can check. OBSERVED live on 2026-07-29 by minting 1
 * card against a scratch fixture: the fence reported exactly these 3 appearing.
 */
const HOOK_PACK = Object.freeze(['commit-msg', 'pre-commit', 'pre-push']);

/** The operator's acknowledgement channel. A path list, `os.pathsep` separated. */
const HOOK_ACK_ENV = 'FERROX_FLEET_HOOK_ACK';

/**
 * ─── WHY THE FENCE WAS NOT ENOUGH (FF-B219, FF-B220) ─────────────────────────
 *
 * `reportHookChange` above OBSERVES the pack landing and names it on stderr.
 * That was the right first move and it is the wrong last one, because by the
 * time it speaks the hooks are already installed. The report tells an operator
 * what happened to their repository; it cannot decline on their behalf.
 *
 * The effects are not cosmetic and they are not confined to the fleet's own
 * worktrees. The pack goes into `git rev-parse --git-common-dir`, which every
 * worktree of the repository shares, INCLUDING the one a human is typing in.
 * Measured by driving the installed hooks rather than by reading them: a commit
 * subject over 72 characters exits 1, a message carrying an AI attribution
 * trailer exits 1, and a direct push of the mainline exits 1 unless
 * `RATCHET_BREAK_GLASS=1` is set.
 *
 * Ferrox is about to be pointed at repositories a human is actively working in.
 * Changing how their own commits behave, as a byproduct of a verb about work
 * cards, is not a surprise to report. It is a thing to REFUSE.
 *
 * ─── WHY CONSENT AND NOT DETECTION ───────────────────────────────────────────
 *
 * "Only refuse when the pack is absent" was rejected. It makes the guard fire
 * once and then never again, so the second repository the operator points at,
 * on a day they are not thinking about hooks, is minted into silently. The
 * question this gate asks is not "are the hooks there", it is "did a human say
 * yes for THIS repository", and the answer to that does not change because a
 * previous run already installed them.
 *
 * What is NOT claimed: this cannot stop the engine installing hooks. It is not
 * a sandbox. It owns the only thing this module actually controls, which is
 * whether the engine is invoked at all, and it sits in phase 1 so a refusal
 * leaves no home, no manifest and no card behind.
 */
function normalizeRepoPath(target) {
  if (typeof target !== 'string' || target.trim() === '') return null;
  const resolved = path.resolve(target.trim());
  try {
    return fs.realpathSync(resolved);
  } catch {
    // A path that does not resolve is still comparable by its lexical form. It
    // is NOT dropped: dropping it would turn a typo in an acknowledgement into
    // a silent refusal whose message blames the wrong thing.
    return resolved;
  }
}

function samePath(a, b) {
  const left = normalizeRepoPath(a);
  const right = normalizeRepoPath(b);
  if (left === null || right === null) return false;
  // Case insensitive on the 2 platforms whose filesystems are, so an
  // acknowledgement typed with a different case is still an acknowledgement.
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/**
 * Whether the caller acknowledged the hook pack FOR THIS REPOSITORY.
 *
 * 2 channels, both of which have to NAME a repository:
 *
 *   - `acknowledgeHooks`, the programmatic one. A path acknowledges that path.
 *     `true` acknowledges the `repoRoot` passed in the SAME call, which is a
 *     naming: the caller wrote both values into 1 invocation.
 *   - `FERROX_FLEET_HOOK_ACK`, the operator's one. A `path.delimiter` separated
 *     list of repository paths.
 *
 * A bare truthy environment variable is deliberately NOT accepted. `=1` would
 * acknowledge every repository the process ever touches, which is the blanket
 * consent this gate exists to refuse.
 */
function resolveHookAck({ repoRoot = REPO_ROOT, acknowledgeHooks, env = process.env } = {}) {
  if (acknowledgeHooks === true) {
    return { acknowledged: true, source: 'parameter', declared: [String(repoRoot)] };
  }

  const fromParam = [];
  if (typeof acknowledgeHooks === 'string' && acknowledgeHooks.trim() !== '') {
    fromParam.push(acknowledgeHooks.trim());
  } else if (Array.isArray(acknowledgeHooks)) {
    for (const entry of acknowledgeHooks) {
      if (typeof entry === 'string' && entry.trim() !== '') fromParam.push(entry.trim());
    }
  }

  const fromEnv = String(env?.[HOOK_ACK_ENV] ?? '')
    .split(path.delimiter).map((s) => s.trim()).filter((s) => s !== '');

  const declared = [...fromParam, ...fromEnv];
  if (fromParam.some((entry) => samePath(entry, repoRoot))) {
    return { acknowledged: true, source: 'parameter', declared };
  }
  if (fromEnv.some((entry) => samePath(entry, repoRoot))) {
    return { acknowledged: true, source: 'environment', declared };
  }
  return { acknowledged: false, source: 'none', declared };
}

function hookAckRefusalLine({ repoRoot, hooksDir }) {
  const where = hooksDir === null || hooksDir === undefined
    ? `the git common directory of ${repoRoot}`
    : hooksDir;
  return withWayOut('REFUSING to mint cards: minting runs `ratchet take`, which installs a git hook pack '
    + `into ${where}.\n\n`
    + 'That directory is shared by EVERY worktree of this repository, including the one a human '
    + 'may be typing in right now, so the change is not confined to the fleet.\n\n'
    + `What would be installed: ${HOOK_PACK.join(', ')}.\n`
    + 'What they do, observed by driving them rather than by reading them:\n'
    + '  - a commit subject longer than 72 characters is refused.\n'
    + '  - a commit message or staged content carrying an AI attribution trailer is refused.\n'
    + '  - a direct push of the mainline is refused unless RATCHET_BREAK_GLASS=1 is set.\n\n'
    + 'Nothing has been written and no card has been minted. Acknowledge this repository, and '
    + 'only this repository, by 1 of:\n'
    + `  - ${HOOK_ACK_ENV}=${repoRoot} <your command>\n`
    + '  - passing acknowledgeHooks to ensureControlPlane, naming this repository.\n\n'
    + 'A bare truthy value is not accepted: an acknowledgement has to name the repository it is '
    + 'for, or it is consent for every repository this process ever touches.\n'
    + 'Not sure: /ferrox-health reports what this project is configured to do.');
}

/**
 * REFUSE to reach the engine at all unless this repository was acknowledged.
 *
 * Returns the verdict when it passes, and the verdict carries `checked: false`
 * with a reason when there is no subject, rather than a green it did not earn.
 * A run that mints 0 cards installs 0 hooks, so it has nothing to consent to,
 * and this project has already shipped a guard that reported green while
 * measuring nothing.
 */
function assertHookPackAcknowledged({
  repoRoot = REPO_ROOT, hooksDir = null, acknowledgeHooks, env = process.env, cardsToMint = 0,
} = {}) {
  if (cardsToMint === 0) {
    return { acknowledged: false, checked: false, source: 'none', reason: 'no-cards-to-mint' };
  }
  const ack = resolveHookAck({ repoRoot, acknowledgeHooks, env });
  if (!ack.acknowledged) throw new ExitError(1, hookAckRefusalLine({ repoRoot, hooksDir }));
  return { acknowledged: true, checked: true, source: ack.source, reason: '' };
}

/** The card store, which is the value `exec` itself reads. */
function readCards(home) {
  const target = cardsPath(home);
  if (!fs.existsSync(target)) return [];
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  return Array.isArray(parsed.cards) ? parsed.cards : [];
}

/** The OPEN card for a slug, or null. Status matters: `exec` requires open. */
function findOpenCard(cards, slug, repoKey = REPO_KEY) {
  const wanted = String(slug);
  return cards.find(
    (c) => String(c.slug) === wanted && c.status === 'open' && String(c.repo) === repoKey,
  ) ?? null;
}

/** The card for a slug in ANY state, or null. */
function findAnyCard(cards, slug, repoKey = REPO_KEY) {
  const wanted = String(slug);
  return cards.find(
    (c) => String(c.slug) === wanted && String(c.repo) === repoKey,
  ) ?? null;
}

/** A card in this state is finished; its node needs no worker. */
const CARD_DONE_STATES = new Set(['landed', 'promoted']);

// ── THE WORK BRIEF: telling the worker what to build ────────────────────────

/**
 * ─── THE DEFECT (FF-B491) ────────────────────────────────────────────────────
 *
 * This module used to mint every card with a title of
 * `phase <n> <node-id>` and nothing else. 4 words. `ratchet-exec:749` then
 * tells the agent, verbatim, "Read the work brief at <path> and complete that
 * card's work in the current directory", and `build_brief` at
 * `ratchet-exec:48-69` composes that brief from the card's `title`, `issue`,
 * `work_id` and `risk` plus the manifest's `mainline`, `lang` and `suite_cmd`.
 *
 * So the whole instruction the worker received was 4 words. The PLAN IS
 * PHYSICALLY PRESENT IN THE WORKTREE and nothing pointed at it. Observed by
 * composing the real brief with the engine's own `build_brief` against a real
 * minted card:
 *
 *     title: phase 30 30-01
 *     issue: none
 *
 * Every success to date depended on the agent independently guessing to go and
 * find its own PLAN.md. That is not a design, it is a coincidence that had been
 * holding.
 *
 * ─── WHICH CHANNELS EXIST, AND WHY THESE 2 ──────────────────────────────────
 *
 * `build_brief` was read, not assumed. Of everything it interpolates, exactly 2
 * are free form and card scoped: `card['title']` and `card['issue']`. Both are
 * set by `ratchet take` from `--title` and `--issue` (`ratchet:1748-1749`,
 * stored at `ratchet:1778`), and both are interpolated raw into an f string
 * that is then newline joined, so neither is truncated, escaped or reflowed and
 * multi line content survives verbatim. `work_id` and `risk` are engine
 * computed. `mainline`, `lang` and `suite_cmd` are manifest scoped and identical
 * for every node, so they cannot carry per node work.
 *
 * THE ENGINE WAS NOT EDITED AND DOES NOT NEED TO BE. Nothing under
 * `ferrox-core/bin/vendor/` changed.
 *
 * ─── WHY EVERYTHING GOES IN `issue` AND THE TITLE IS LEFT ALONE ─────────────
 *
 * The first build of this put the objective, the plan pointer and the write
 * lane into the TITLE, because a title is the prominent field. It was WRONG,
 * and the suite caught it: 3 real dispatches in `tests/fleet-land-proof.test.cjs`
 * came back `exec: REJECTED, out-of-lane write ['land-proof.txt']`.
 *
 * The cause, read out of the engine rather than guessed:
 * `ratchet-index:388` computes the exec sandbox's WRITE MANIFEST with
 *
 *     kws = _keywords(card.get("title", "") + " " + card.get("slug", ""))
 *
 * and grants the directories of whatever files those keywords match. So the
 * card title is an INPUT TO A SECURITY BOUNDARY. Enriching it fed the plan
 * path's own words into that matcher, the index confidently scoped the lane to
 * `.planning/phases/<phase>/**`, and the worker was then forbidden from writing
 * the very files it existed to write. A brief that tells the agent what to
 * build while silently revoking its permission to build it is worse than the 4
 * word title it replaced.
 *
 * `issue` is read by `build_brief` and by the glass board's display, and by
 * NOTHING that decides anything. Verified by grepping every entrypoint under
 * `ferrox-core/bin/vendor/ratchet/bin/` for the key: `ratchet-exec:57` and
 * `ratchet-glass:329,350`. `ratchet-index` never reads it.
 *
 * So the title is left BYTE IDENTICAL to what this module always minted, and
 * the whole brief goes in `issue`. An arm pins that with the engine's own
 * `_keywords`, because "the title is unchanged" is the kind of claim that rots.
 *
 * The path is REPO RELATIVE, never absolute. The worker runs inside an isolated
 * clone of its own worktree and is told to work only in the current directory;
 * an absolute path would point it at the primary tree it must not touch.
 */

/** The title this module has always minted. An INPUT TO compute_grant. */
function cardTitle({ phase, nodeId }) {
  return `${phase === undefined || phase === null ? '' : `phase ${phase} `}${nodeId}`.trim();
}

/** The plan file for a node, discovered rather than assumed. */
function locatePlanFile({
  repoRoot = REPO_ROOT, phase, nodeId, planningDirName = '.planning', io = fs,
} = {}) {
  const id = String(nodeId);
  const wanted = `${id}-PLAN.md`;
  const phasesDir = path.join(repoRoot, planningDirName, 'phases');

  let entries;
  try {
    entries = io.readdirSync(phasesDir, { withFileTypes: true });
  } catch {
    return { path: null, reason: `no phase directory tree was readable at ${phasesDir}` };
  }

  const hits = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(phasesDir, entry.name, wanted);
    if (io.existsSync(candidate)) hits.push({ dir: entry.name, abs: candidate });
  }

  if (hits.length === 0) {
    return { path: null, reason: `no ${wanted} exists under any phase directory in ${phasesDir}` };
  }

  // The plan id already encodes its phase, so 1 hit is the normal case and the
  // lookup never has to reimplement the phase token matching that
  // `phase-plan-index` owns. When 2 phase directories carry the same plan file
  // name the phase is used to break the tie, and an unbreakable tie REFUSES to
  // guess: a brief pointing at the wrong plan is worse than a brief admitting
  // it found none, because the worker cannot tell.
  let chosen = hits[0];
  if (hits.length > 1) {
    const token = String(phase ?? '');
    const preferred = hits.filter((h) => token !== '' && h.dir.split('-')[0] === token);
    if (preferred.length !== 1) {
      return {
        path: null,
        reason: `${hits.length} phase directories carry a ${wanted} `
          + `(${hits.map((h) => h.dir).join(', ')}) and phase ${JSON.stringify(token)} does not `
          + 'single one out, so no plan path is claimed rather than guessed',
      };
    }
    chosen = preferred[0];
  }

  const relative = path.relative(repoRoot, chosen.abs).split(path.sep).join('/');
  return { path: relative, reason: '' };
}

/** The shipped `phase-plan-index` verb, read as a child process. */
function defaultRunPlanIndex({ ferroxRoot = FERROX_ROOT, repoRoot = REPO_ROOT, phase } = {}) {
  const proc = spawnSync(
    process.execPath,
    [
      path.join(ferroxRoot, ...FERROX_TOOLS_ENTRYPOINT),
      'phase-plan-index', String(phase ?? ''), '--cwd', repoRoot, '--raw',
    ],
    { encoding: 'utf8' },
  );
  if (proc.error !== undefined && proc.error !== null) return { status: 1, stdout: '', stderr: '' };
  return { status: proc.status, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/**
 * The objective and write lane per plan id, from the verb that owns them.
 *
 * `phase-plan-index` already parses plan frontmatter and the `<objective>` tag,
 * and it is the shipped producer. Reimplementing that parse here would give
 * this module a second, quietly diverging opinion about what a plan declares.
 *
 * Never fatal. A repository with no `.planning` tree, which every scratch
 * fixture in this suite is, must still be able to mint.
 */
function readPlanFacts({
  ferroxRoot = FERROX_ROOT, repoRoot = REPO_ROOT, phase, runPlanIndex = defaultRunPlanIndex,
} = {}) {
  const proc = runPlanIndex({ ferroxRoot, repoRoot, phase });
  if (proc.status !== 0) return { facts: {}, reason: `phase-plan-index exited ${proc.status}` };
  let parsed;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch {
    return { facts: {}, reason: 'phase-plan-index printed output that is not JSON' };
  }
  const plans = Array.isArray(parsed?.plans) ? parsed.plans : [];
  const facts = {};
  for (const plan of plans) {
    const id = String(plan?.id ?? '');
    if (id === '') continue;
    const objective = typeof plan?.objective === 'string' ? plan.objective.trim() : '';
    const lane = Array.isArray(plan?.files_modified)
      ? plan.files_modified.map((f) => String(f)).filter((f) => f !== '')
      : [];
    facts[id] = { objective, files_modified: lane };
  }
  return { facts, reason: typeof parsed?.error === 'string' ? String(parsed.error) : '' };
}

/**
 * The 2 card fields that reach the agent, composed from what the plan declares.
 *
 * Returns `{ title, issue, plan_path, objective, files_modified }`. The last 3
 * are the INPUTS echoed back so a caller, and a test, can assert on content
 * rather than on a boolean saying the brief was enriched. A flag would pass for
 * an implementation that sets a field nothing reads.
 */
function composeCardBrief({
  phase, nodeId, planPath = null, objective = '', filesModified = [], planReason = '',
} = {}) {
  const lane = Array.isArray(filesModified) ? filesModified.map((f) => String(f)) : [];
  const objectiveText = typeof objective === 'string' ? objective.trim() : '';

  const lines = [];
  if (planPath === null) {
    lines.push(
      'NO PLAN FILE WAS LOCATED for this node, so this brief names no plan, no objective and no '
        + `write lane. Reason: ${planReason === '' ? 'not stated' : planReason}. Say so in `
        + 'DELIVERY.md rather than inventing scope.',
    );
  } else {
    // The bare path FIRST, on its own line, so the most useful value in this
    // field is also the easiest one to find.
    lines.push(
      planPath,
      'READ THAT FILE FIRST. It is the authoritative plan for this card, it is RELATIVE TO YOUR '
        + 'WORKTREE ROOT, which is the current directory, and it is already there. Open it before '
        + 'you change anything. This brief is a pointer to that plan, never a substitute for it.',
    );
    if (objectiveText !== '') lines.push(`OBJECTIVE: ${objectiveText}`);
  }

  if (lane.length === 0) {
    lines.push(
      planPath === null
        ? 'WRITE LANE: unknown, because no plan was located.'
        : 'WRITE LANE: that plan declares no files_modified, so no lane is named here. Read the '
          + 'plan for the scope it does declare.',
    );
  } else {
    lines.push(
      `WRITE LANE, the ${lane.length} path(s) that plan declares in files_modified:`,
      ...lane.map((f) => `- ${f}`),
    );
  }

  return {
    // BYTE IDENTICAL to what this module always minted. See the block above:
    // the title is an input to `compute_grant`, which is a security boundary.
    title: cardTitle({ phase, nodeId }),
    issue: lines.join('\n'),
    plan_path: planPath,
    objective: objectiveText,
    files_modified: lane,
  };
}

/** The brief inputs for 1 node, discovered from the repository. */
function briefForNode({
  repoRoot = REPO_ROOT, phase, nodeId, facts = {}, planningDirName = '.planning', io = fs,
} = {}) {
  const located = locatePlanFile({ repoRoot, phase, nodeId, planningDirName, io });
  const fact = facts[String(nodeId)] ?? { objective: '', files_modified: [] };
  return composeCardBrief({
    phase,
    nodeId,
    planPath: located.path,
    objective: fact.objective,
    filesModified: fact.files_modified,
    planReason: located.reason,
  });
}

/**
 * Mint a card for 1 node, or return the open one that already exists.
 *
 * Idempotent on purpose. A driver that re-ran and minted a second card for the
 * same node would leave 2 open cards competing for 1 worktree, and `take` itself
 * reserves the worktree, so the second would fail late rather than early.
 */
function ensureCard({
  home, repoRoot = REPO_ROOT, engineRoot = FERROX_ROOT, repoKey = REPO_KEY, slug, title, issue,
  spawnEngine = defaultSpawnEngine,
}) {
  const existing = findOpenCard(readCards(home), slug, repoKey);
  if (existing !== null) return { card: existing, created: false };

  // A card can exist and NOT be open, and re-taking one is not idempotent: the
  // branch `take` wants already exists and the verb rolls back. Observed live
  // after an aborted land, which sets the card to `landing` BEFORE running the
  // suite and leaves it there when the suite fails. A blind re-take then reads
  // as "left no OPEN card", which describes the symptom and hides the cause.
  const stale = findAnyCard(readCards(home), slug, repoKey);
  if (stale !== null) {
    if (CARD_DONE_STATES.has(String(stale.status))) {
      return { card: stale, created: false, done: true };
    }
    throw new ExitError(
      1,
      `the card for ${JSON.stringify(String(slug))} is in state `
        + `${JSON.stringify(String(stale.status))}, not "open", so no worker can claim it and `
        + 'minting a second card would collide with the branch the first one already holds.\n'
        + 'A `landing` card is an interrupted land. Repair it with:\n'
        + `  RATCHET_HOME=${home} ratchet reconcile`,
    );
  }

  // `--issue` is OMITTED rather than passed empty when no plan was located, so
  // the brief renders the engine's own `issue: none` instead of a blank label
  // that reads like a value somebody meant to set.
  const args = ['take', String(slug), '--repo', repoKey, '--title', String(title ?? slug)];
  const issueRef = typeof issue === 'string' ? issue.trim() : '';
  if (issueRef !== '') args.push('--issue', issueRef);

  const result = spawnEngine({ home, repoRoot, engineRoot, args });

  const card = findOpenCard(readCards(home), slug, repoKey);
  if (card === null) {
    throw new ExitError(
      1,
      `ratchet take ${slug} left no OPEN card in ${cardsPath(home)} (exit ${result.status}). `
        + 'Without a card the worker seam has no work id to dispatch and every worker refuses.\n'
        + `${result.stdout}${result.stderr}`,
    );
  }
  return { card, created: true };
}

/**
 * The engine resolves from `engineRoot`, the FERROX install, NOT from the
 * target repository. See FERROX_ROOT: resolving it under `repoRoot` made every
 * foreign repository die ENOENT, because a repository that is not this one
 * vendors no ratchet. `cwd` stays the target repo, which is where the engine's
 * own git calls belong.
 */
function defaultSpawnEngine({ home, repoRoot = REPO_ROOT, engineRoot = FERROX_ROOT, args }) {
  const proc = spawnSync(path.join(engineRoot, ...RATCHET_ENTRYPOINT), args, {
    cwd: repoRoot,
    env: engineEnv(home),
    encoding: 'utf8',
  });
  if (proc.error !== undefined && proc.error !== null) throw proc.error;
  return { status: proc.status, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/**
 * The whole plane for a phase: home, manifest, and 1 card per workgraph node.
 *
 * Returns the mapping the worker seam needs, keyed by node id, carrying BOTH the
 * work id `exec` matches on and the isolated worktree `take` created. The
 * worktree is why this is worth more than a card: `runLoop`'s `worktreeOf`
 * default is a placeholder, and this is the real one, on its own branch off a
 * freshly fetched mainline with hooks installed.
 */
function ensureControlPlane({
  repoRoot = REPO_ROOT,
  home,
  phase,
  nodes,
  repoKey = REPO_KEY,
  // WHERE FERROX IS, which is not where the fleet builds. See FERROX_ROOT.
  engineRoot = FERROX_ROOT,
  execGit = defaultExecGit,
  execGh = defaultExecGh,
  spawnEngine = defaultSpawnEngine,
  preferRemote,
  hookIo = defaultHookIo,
  warn = defaultWarn,
  // The land gate's suite command, defaulting to the shipped constant. A proof
  // that drives this whole chain against a scratch fixture cannot afford to
  // install a dependency tree inside a scratch worktree, and a proof nobody runs
  // because it is slow and needs a network is not a proof.
  suiteCmd,
  // The hook pack consent gate. See assertHookPackAcknowledged.
  acknowledgeHooks,
  env = process.env,
  // The brief seams, so a test can drive them without a `.planning` tree.
  runPlanIndex = defaultRunPlanIndex,
  planningDirName = '.planning',
  briefIo = fs,
} = {}) {
  const nodeList = [...nodes];

  // ── PHASE 1, PURE READS. Every refusal below leaves the filesystem exactly
  // as it found it. ────────────────────────────────────────────────────────
  const planned = planManifest({
    repoRoot, home, execGit, preferRemote, execGh, suiteCmd, repoKey,
  });

  // Before a single card is minted AND before a single byte is written, because
  // a card carries a worktree, a worktree cut from a stale base is the failure
  // this check exists to stop, and a manifest left behind by a refusal is state
  // the next run will read as a decision somebody made.
  //
  // A graph with 0 nodes cuts 0 worktrees, so the check has no subject and is
  // SKIPPED rather than passed. It reports `checked: false` and says why: this
  // project has already been bitten by a guard that reported green while
  // measuring nothing, and "nothing is stale" is vacuously true of a graph that
  // has no nodes. A caller must be able to tell the 2 apart.
  //
  // The topology passed here is the one `planManifest` already observed. It used
  // to be observed a SECOND time, with a different preferred remote resolution,
  // so the 2 observations could in principle disagree about the very ref this
  // check measures against. 1 observation, 2 consumers.
  const base = nodeList.length === 0
    ? { ref: null, commits_ahead: null, checked: false, reason: 'no-nodes-to-mint' }
    : {
      ...assertBranchPointIsCurrent({ repoRoot, topology: planned.topology, execGit }),
      checked: true,
    };

  // The hook set as it stands BEFORE anything is minted. Read only, so it still
  // belongs to phase 1, and it must be taken before the first `take` rather than
  // after, or the pack the engine installs is already indistinguishable from a
  // pack that was always there.
  const hooksDir = resolveHooksDir({ repoRoot, execGit });
  const hooksBefore = observeHooks({ hooksDir, io: hookIo });

  // THE CONSENT GATE, and its position in the file is the whole of its value.
  // It is the LAST thing in phase 1, so it runs after everything that could
  // refuse for a better reason and before the first byte is written. A run that
  // refuses here has not created the home, has not written the manifest and has
  // not reached the engine, so the count of card minting invocations it caused
  // is 0 rather than "0 that we noticed".
  const hookAck = assertHookPackAcknowledged({
    repoRoot, hooksDir, acknowledgeHooks, env, cardsToMint: nodeList.length,
  });

  // The brief inputs, read once for the whole phase. Read only, and never fatal:
  // a repository with no plan tree still mints, and every brief it produces says
  // plainly that it found no plan rather than quietly carrying 4 words.
  const planFacts = nodeList.length === 0
    ? { facts: {}, reason: 'no-nodes-to-brief' }
    : readPlanFacts({ ferroxRoot: engineRoot, repoRoot, phase, runPlanIndex });

  // ── PHASE 2, THE WRITES. Nothing below decides anything. ─────────────────
  const ensured = writeManifest(planned);

  const cards = {};
  const created = [];
  const briefs = {};
  for (const nodeId of nodeList) {
    const brief = briefForNode({
      repoRoot, phase, nodeId, facts: planFacts.facts, planningDirName, io: briefIo,
    });
    briefs[nodeId] = {
      plan_path: brief.plan_path,
      objective: brief.objective,
      files_modified: brief.files_modified,
      title: brief.title,
      issue: brief.issue,
    };
    const { card, created: fresh } = ensureCard({
      home: ensured.home, repoRoot, engineRoot, repoKey, slug: nodeId,
      title: brief.title,
      issue: brief.issue,
      spawnEngine,
    });
    cards[nodeId] = { work_id: String(card.work_id), worktree: String(card.worktree) };
    if (fresh) created.push(nodeId);
  }

  const hooks = reportHookChange({
    before: hooksBefore,
    after: observeHooks({ hooksDir, io: hookIo }),
    warn,
  });

  return {
    home: ensured.home,
    manifest_path: ensured.manifestPath,
    repo_key: repoKey,
    base,
    cards,
    created,
    hooks,
    hook_ack: hookAck,
    // The brief per node, echoed so a caller can see WHAT the worker was told
    // rather than a boolean claiming it was told something.
    briefs,
    brief_source: {
      reason: planFacts.reason,
      briefed: Object.values(briefs).filter((b) => b.plan_path !== null).length,
      unbriefed: Object.values(briefs).filter((b) => b.plan_path === null).length,
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const flagValue = (name) => {
    const at = argv.indexOf(name);
    return at !== -1 && at + 1 < argv.length ? argv[at + 1] : undefined;
  };
  // A VALUE TAKING flag consumes the argument after it, so that argument is not
  // a positional. Filtering on the leading dashes alone made
  // `--repo-root /some/path 30` read `/some/path` as the phase, which is the
  // shape that turns a typo into a run against the wrong thing.
  const VALUE_FLAGS = ['--repo-root', '--repo-key', '--suite-cmd'];
  const valueIndexes = new Set(
    VALUE_FLAGS.map((f) => argv.indexOf(f)).filter((i) => i !== -1).map((i) => i + 1),
  );
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valueIndexes.has(i));
  if (positional.length === 0) {
    throw new ExitError(
      1,
      'fleet-controlplane.cjs needs a phase as its first argument. Run:\n'
        + '  node scripts/fleet-controlplane.cjs <phase>',
    );
  }
  const phase = positional[0];
  const raw = argv.includes('--raw');
  // The TARGET repository, which defaults to this one and is not required to be.
  const repoRoot = path.resolve(flagValue('--repo-root') ?? REPO_ROOT);
  const repoKey = flagValue('--repo-key') ?? REPO_KEY;
  const suiteCmd = flagValue('--suite-cmd');

  const workgraphScan = require(
    path.join(FERROX_ROOT, 'ferrox-core', 'bin', 'lib', 'workgraph-scan.cjs'),
  );
  const built = workgraphScan.buildWorkgraph({ cwd: repoRoot, phase });
  if (!built.ok && built.message !== '') throw new ExitError(1, built.message);
  const nodes = (built.document.nodes ?? []).map((n) => String(n.id));

  const plane = ensureControlPlane({
    repoRoot,
    repoKey,
    suiteCmd,
    phase,
    nodes,
    acknowledgeHooks: argv.includes('--ack-hooks') ? repoRoot : undefined,
  });
  process.stdout.write(`${raw ? JSON.stringify(plane) : JSON.stringify(plane, null, 2)}\n`);
  return 0;
}

if (require.main === module) runMain(main);

module.exports = {
  RATCHET_ENTRYPOINT,
  FERROX_TOOLS_ENTRYPOINT,
  FERROX_ROOT,
  REPO_ROOT,
  REPO_KEY,
  GH_LOGIN_LOCAL,
  SUITE_CMD,
  HOOK_PACK,
  HOOK_ACK_ENV,
  normalizeRepoPath,
  samePath,
  resolveHookAck,
  hookAckRefusalLine,
  assertHookPackAcknowledged,
  locatePlanFile,
  defaultRunPlanIndex,
  readPlanFacts,
  composeCardBrief,
  briefForNode,
  effectiveGhLogin,
  resolveGhLogin,
  defaultExecGh,
  engineEnv,
  ratchetHomePath,
  manifestPath,
  cardsPath,
  worktreeRootPath,
  normalizeRemoteUrl,
  observeTopology,
  assertBranchPointIsCurrent,
  buildManifest,
  planManifest,
  writeManifest,
  defaultHookIo,
  defaultWarn,
  resolveHooksDir,
  observeHooks,
  hookChangeLine,
  reportHookChange,
  ensureManifest,
  committedRemote,
  readCards,
  findOpenCard,
  findAnyCard,
  CARD_DONE_STATES,
  ensureCard,
  ensureControlPlane,
  defaultExecGit,
  defaultSpawnEngine,
};
