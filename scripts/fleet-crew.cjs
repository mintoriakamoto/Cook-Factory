#!/usr/bin/env node
'use strict';

/**
 * fleet-crew.cjs: Phase 21 of milestone v1.14 (Fleet Mode), the CREW view.
 *
 * WHAT THIS SURFACE EXISTS TO SHOW, and why nothing before it showed it.
 *
 * The product claim is several DIFFERENT vendor CLIs working 1 dependency graph
 * at the same time. Everything built up to here treats the adapter as 1 fixed
 * identity, and that is not an accident or an oversight: the benchmark HELD the
 * adapter fixed on purpose, because varying the vendor and the concurrency at
 * once confounds model speed with parallelism and produces a number nobody can
 * attribute. That was a MEASUREMENT constraint. It then leaked into the product,
 * where it is not a constraint at all, and this file is where the leak is
 * closed. It is the 1 screen that shows a crew rather than a worker.
 *
 * THE CREW IS THE TEAM. IT IS NOT A SECOND CONCEPT BESIDE THE TEAM.
 * `src/team-manifest.cts` already ships `team-manifest/v1`, and its `TeamRole`
 * at :122-131 already binds a role to either a NAMED CLAUDE CODE SUBAGENT
 * (`{ agent: string }`) or to INLINE execution (`{ inline: true }`), carrying the
 * rung dispatch actually uses in `effective_binding`. So the roster below reads
 * THAT manifest and renders 1 row per ROLE. It does not fork it, it does not
 * re derive it, and it does not keep a private list of members beside it. This
 * project has been bitten by exactly that shape before: a benchmark that grew
 * its own scheduler instead of calling `src/fleet-manager.cts` cost a day and a
 * wrong published number. The producer is the authority and this file adapts at
 * the READER.
 *
 * THE GAP THIS VIEW MAKES VISIBLE, stated exactly and not smuggled shut.
 * The binding union has 2 members and the product needs a third. An EXTERNAL CLI
 * binding, `{ cli: <identity> }`, DOES NOT EXIST in the schema today. This file
 * adds nothing to that union, widens no validator and invents no binding: the
 * validator refuses unknown bindings on purpose and that refusal is load bearing.
 * What this file does instead is render what the manifest actually says AND
 * render, separately and clearly labelled, the vendor backends a role COULD be
 * bound to once the union carries that third member. What the change would cost
 * is recorded in `CLI_BINDING_GAP` below with its file and its line, and it is a
 * real schema change with its own refusal arm and its own battery, which is a
 * plan and not a view.
 *
 * THE 3 VERBS.
 *
 *   roster           the TEAM, 1 row per role, with what backs each one
 *   probe            which vendor backends actually answer, spend gated
 *   assign <phase>   which team member takes which node of a real graph
 *
 * ON PATH, CONFIGURED and READY ARE 3 DIFFERENT FACTS AND ARE NEVER COLLAPSED.
 * A binary present on this machine is not a binary this project declared. A
 * binary this project declared is not a binary that answered a prompt. Any 2 of
 * those 3 can hold while the third fails, and every collapse of them produces
 * the same bad outcome: a green report that hides a dead vendor. So the roster
 * renders all 3 as separate columns, and the READY column reads UNKNOWN until
 * `probe` has actually run. UNKNOWN IS NEVER RENDERED AS 0 AND NEVER AS A BLANK,
 * because 0 ready is a measurement and an unmeasured lane is not one.
 *
 * `roster` NEVER SPAWNS AN ADAPTER, AND THAT IS ENFORCED RATHER THAN INTENDED.
 * PATH membership is resolved by READING the directories on PATH and checking
 * the executable bit, never by running the binary with a version flag. The
 * recorded defect this avoids is a suite that made 12 real paid calls per run
 * because a probe fired unasked inside something that read as a status command.
 * `tests/fleet-crew.test.cjs` drives `roster` as a real child process with
 * counting shims installed on PATH under all 3 adapter names, asserts the
 * rendered output is NON EMPTY first, and only then asserts the spawn counter is
 * EXACTLY 0. Asserting no spawn without first asserting real output is vacuously
 * true of a command that printed nothing.
 *
 * PROBING SPENDS MONEY, SO THE REAL LANE IS OPT IN AND IS NEVER THE DEFAULT.
 * `probe` runs the MOCK lane unless `--real` is passed. The mock lane is the
 * probe module's own zero spend adapter, which reaches no network and no model,
 * and it measures the PLUMBING rather than a vendor. That distinction is carried
 * in the rendered wording, because a mock READY presented as a vendor READY is a
 * worse lie than no probe at all. The real lane STATES ITS EXPECTED SPEND, as a
 * call count, before it makes the first call.
 *
 * `assign` IS A PROJECTION AND IS NOT A DISPATCH. It computes who WOULD take
 * which node under the shipped work graph and the configured crew, and it spawns
 * nothing, writes nothing and starts nothing. The dispatch consumer that carries
 * a chosen adapter through the worker seam is FF-B379 and it is open; until it
 * lands, the seam passes no adapter flag at all and the engine picks a lane by
 * probing the machine (FF-B233). Every rendered assignment therefore carries the
 * word PROJECTION, and the view refuses to imply otherwise.
 *
 * WHY THE EXCLUSIONS ARE RENDERED RATHER THAN OMITTED. `kimi` and `wayland-core`
 * are both absent from the dispatchable crew for stated reasons, and an absence
 * with no reason attached is indistinguishable from a bug. So both are printed,
 * each with its reason and its backlog id. A roster that names its own exclusions
 * cannot silently shrink.
 *
 * THIS MODULE WRITES NOTHING and it never reaches under `ferrox-core/bin/vendor/`
 * except to let the probe module do so, which is byte pinned and read only.
 *
 * Usage:
 *   node scripts/fleet-crew.cjs roster
 *   node scripts/fleet-crew.cjs probe [--real]
 *   node scripts/fleet-crew.cjs assign <phase>
 *
 * FERROX_CREW_ROOT overrides the project root, matching the seam
 * `scripts/fleet-glass.cjs` uses, so every arm is drivable against a scratch tree
 * as a real child process.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ExitError, runMain, withWayOut } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.FERROX_CREW_ROOT
  ? path.resolve(process.env.FERROX_CREW_ROOT)
  : REPO_ROOT;
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');

/** The 2 built libs this seam reaches for, named as a human would fix them. */
const PROBE_MODULE = 'ferrox-core/bin/lib/fleet-probe.cjs';
const SCAN_MODULE = 'ferrox-core/bin/lib/workgraph-scan.cjs';

const TEAM_MODULE = 'ferrox-core/bin/lib/team-manifest.cjs';

/** Where the crew is DECLARED. Never inferred from what happens to be installed. */
const ADAPTERS_CONFIG_KEY = 'fleet.adapters';
const CONFIG_RELPATH = path.join('.planning', 'config.json');

/** The single roster manifest, per `src/team-manifest.cts:4`. */
const TEAM_RELPATH = path.join('.planning', 'TEAM.md');

/**
 * The gap this view exists to make visible, stated with its file and its line so
 * nobody has to go looking, and NOT closed here.
 *
 * A `{ cli: <identity> }` binding is the third rung the product needs and the
 * schema does not have. Adding it is a real change with a real cost, and a view
 * is the wrong place to smuggle a schema widening into.
 */
const CLI_BINDING_GAP = Object.freeze({
  file: 'src/team-manifest.cts',
  line: '122-131',
  union: '{ agent: string } | { inline: true }',
  missing: '{ cli: <adapter identity> }',
  cost: 'a third member on the TeamRole binding union at src/team-manifest.cts:128, a third value on '
    + "effective_binding at :130 (today 'agent' | 'inline'), a matching branch in the binding validator "
    + 'which REFUSES unknown bindings on purpose, a refusal arm proving an unknown cli identity is still '
    + 'refused, and a manifest hash consequence because the binding is hashed. That is a schema change '
    + 'with its own battery and it deserves its own plan. This view adds NOTHING to that union.',
});

/**
 * The identity the probe module carries a profile for that is NOT a crew member:
 * the zero spend selftest lane. It is a real adapter to the engine and it is not
 * a vendor, so it is excluded from the crew and used as the default probe lane.
 */
const MOCK_IDENTITY = 'mock';

/**
 * Adapter identities held OUT of the dispatchable crew, each with the reason and
 * the backlog row that owns it.
 *
 * `wayland-core` IS in the engine's own PROFILES table and is still not a crew
 * member here, because it is a metered service lane rather than a locally
 * installed vendor binary, so a PATH reading of it measures nothing and a probe
 * of it measures that service.
 *
 * `kimi` is the opposite shape: configurable as a fleet adapter, present in the
 * runtime alias manifest, and NOT dispatchable by the byte pinned engine.
 */
const CREW_EXCLUSIONS = Object.freeze({
  kimi: Object.freeze({
    backlog: 'FF-B225',
    reason: 'configurable as a fleet adapter and NOT dispatchable by the vendored engine. Adding it '
      + 'costs a mutation of the byte pinned engine PROFILES literal plus a DIVERGENCES entry and a '
      + 're pin, which is a milestone level decision against the vendor pinning policy rather than an '
      + 'edit. Configured today it would probe NOT_READY with reason not-dispatchable and spend 0 calls.',
  }),
  'wayland-core': Object.freeze({
    backlog: 'FF-B225',
    reason: 'the universal fallback lane, routed through a metered service rather than a locally '
      + 'installed adapter binary, so a PATH reading of it measures nothing about this machine and a '
      + 'probe of it measures that service. Dispatchable by the engine and deliberately out of crew.',
  }),
});

/** The 3 facts, worded as 3 different claims because they are 3 different claims. */
const FACT_WORDING = Object.freeze({
  ON_PATH: 'ON PATH: a file with the executable bit was found on this PATH under this name.',
  CONFIGURED: `CONFIGURED: this project DECLARED the identity in ${ADAPTERS_CONFIG_KEY}.`,
  READY: 'READY: the identity answered a nonce bearing probe prompt with that nonce.',
  UNKNOWN: 'UNKNOWN: no probe has been run in this invocation, so readiness was never measured. '
    + 'This is not 0 ready and it is not a blank. It is an unmeasured lane.',
});

const CREW_ERROR_CODES = Object.freeze({
  UNAVAILABLE: 'E_CREW_UNAVAILABLE',
  EMPTY_CREW: 'E_CREW_EMPTY',
  USAGE: 'E_CREW_USAGE',
});

/** The refusal an empty configured crew earns, named so a case can assert WHICH rule fired. */
const EMPTY_CREW_RULE = 'empty-configured-crew';

/** The label every projected assignment carries. */
const PROJECTION_LABEL = 'PROJECTION, not a dispatch';

const RULE = '-'.repeat(78);

/* ------------------------------------------------------------------------ *
 * Small helpers. Every one of these is total: no input throws.
 * ------------------------------------------------------------------------ */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilledString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** A count with its noun pluralized. Digits always, never a spelled number. */
function count(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Pad to a width for the aligned roster. Never truncates a name. */
function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * Load the probe module, or refuse with a NAMED missing.
 *
 * Injected so every arm is drivable without a built tree, guarded require
 * otherwise, following `scripts/fleet-glass.cjs`.
 */
function loadProbe(load) {
  const loader = typeof load === 'function'
    ? load
    : () => require(path.join(LIB_DIR, 'fleet-probe.cjs'));
  try {
    const mod = loader();
    if (!mod || !isPlainObject(mod.ADAPTER_PROFILES)) {
      return { ok: false, code: CREW_ERROR_CODES.UNAVAILABLE, missing: `${PROBE_MODULE} loaded but exports no ADAPTER_PROFILES` };
    }
    return { ok: true, probe: mod };
  } catch (error) {
    return {
      ok: false,
      code: CREW_ERROR_CODES.UNAVAILABLE,
      missing: `${PROBE_MODULE}\n${error && error.message ? error.message : String(error)}\n`
        + 'Fix: run:\n  npm run build:lib',
    };
  }
}

/**
 * The dispatchable crew: the probe module's own shipped profile table, minus the
 * zero spend mock lane and minus every stated exclusion.
 *
 * DERIVED, never retyped. A hardcoded list here would agree with the engine on
 * the day it was written and drift silently afterwards, which is the exact defect
 * FF-B225 records between the 2 rosters this project already reads.
 */
function dispatchableIdentities(probeModule) {
  if (!probeModule || !isPlainObject(probeModule.ADAPTER_PROFILES)) return [];
  return Object.keys(probeModule.ADAPTER_PROFILES)
    .filter((id) => id !== MOCK_IDENTITY)
    .filter((id) => !Object.prototype.hasOwnProperty.call(CREW_EXCLUSIONS, id))
    .sort();
}

/* ------------------------------------------------------------------------ *
 * Fact 1: ON PATH. Resolved by READING, never by running.
 * ------------------------------------------------------------------------ */

/**
 * Resolve a bare binary name through a PATH value, or null.
 *
 * READS the directories and checks the executable bit. It does NOT spawn the
 * binary with a version flag, which is the ordinary way a status command turns
 * into a paid call: 3 adapters times every invocation of what a human believed
 * was a free listing.
 *
 * PURE over its arguments: it touches the filesystem and nothing else, reads no
 * clock, and takes the PATH value as an argument rather than reading the
 * environment, so the scrubbed arm is drivable in process as well as through a
 * child.
 *
 * @param {string} bin a bare binary name
 * @param {string} pathValue the PATH value to search
 * @returns {string|null} the absolute path of the first executable match
 */
function resolveOnPath(bin, pathValue) {
  if (!isFilledString(bin)) return null;
  if (bin.includes('/') || bin.includes('\\')) return null;
  const dirs = String(pathValue === undefined || pathValue === null ? '' : pathValue)
    .split(path.delimiter)
    .filter((d) => d !== '');
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      /* an unreadable or absent entry is simply not a match */
    }
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * Fact 2: CONFIGURED. Declared by the project, never inferred.
 * ------------------------------------------------------------------------ */

/**
 * Read the declared crew from `.planning/config.json`.
 *
 * An ABSENT `fleet` key, an absent config file and a `fleet.adapters` set to the
 * empty array are 3 different situations and they carry 3 different `state`
 * values, because the fix for each is different. All 3 yield 0 configured
 * adapters, and the roster renders that emptiness explicitly rather than as a
 * blank region a reader mistakes for a rendering fault.
 *
 * @returns {{adapters: string[], state: string, detail: string, file: string}}
 */
function loadConfiguredRoster(input) {
  const source = isPlainObject(input) ? input : {};
  const root = isFilledString(source.root) ? source.root : ROOT;
  const file = path.join(root, CONFIG_RELPATH);

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {
      adapters: [],
      state: 'no-config-file',
      detail: `no file at ${CONFIG_RELPATH}, so this project has declared no crew at all`,
      file,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      adapters: [],
      state: 'unreadable-config',
      detail: `${CONFIG_RELPATH} did not parse as JSON: ${error && error.message ? error.message : String(error)}`,
      file,
    };
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.fleet)) {
    return {
      adapters: [],
      state: 'no-fleet-key',
      detail: `${CONFIG_RELPATH} carries no "fleet" key at all, so ${ADAPTERS_CONFIG_KEY} is not merely `
        + 'empty, it was never written',
      file,
    };
  }
  if (!Array.isArray(parsed.fleet.adapters)) {
    return {
      adapters: [],
      state: 'no-adapters-key',
      detail: `${CONFIG_RELPATH} carries a "fleet" key with no "adapters" array under it`,
      file,
    };
  }

  const adapters = parsed.fleet.adapters.filter(isFilledString).map((s) => s.trim());
  if (adapters.length === 0) {
    return {
      adapters: [],
      state: 'empty-adapters',
      detail: `${ADAPTERS_CONFIG_KEY} was written and it names 0 identities`,
      file,
    };
  }
  return { adapters, state: 'declared', detail: `${ADAPTERS_CONFIG_KEY} names ${count(adapters.length, 'identity', 'identities')}`, file };
}

/* ------------------------------------------------------------------------ *
 * The TEAM. Read from the shipped manifest, never re derived.
 * ------------------------------------------------------------------------ */

/**
 * Read `.planning/TEAM.md` through the SHIPPED parser.
 *
 * AN ABSENT TEAM AND AN EMPTY TEAM ARE 2 DIFFERENT FACTS and they carry 2
 * different states, for the same reason an unavailable panel is not an empty
 * panel: the fix for each is different, and a view with 1 rendering for both
 * tells a reader that this project decided to have no roles when the truth is
 * that nobody has written the file.
 *
 * The parser's OWN refusal messages are carried through INTACT rather than
 * paraphrased, because they already name the code and the path.
 *
 * @returns {{state: string, roles: object[], detail: string, file: string}}
 */
function loadTeam(input) {
  const source = isPlainObject(input) ? input : {};
  const root = isFilledString(source.root) ? source.root : ROOT;
  const file = path.join(root, TEAM_RELPATH);

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {
      state: 'absent',
      roles: [],
      detail: `no file at ${TEAM_RELPATH}, so this project has DECLARED NO TEAM at all. An absent team `
        + 'is not an empty team: nothing was decided here, and a role by role view has nothing to read. '
        + 'Fix: run the team staffing step of the milestone, which writes that manifest.',
      file,
    };
  }

  const load = typeof source.load === 'function'
    ? source.load
    : () => require(path.join(LIB_DIR, 'team-manifest.cjs'));
  let team;
  try {
    team = load();
  } catch (error) {
    return {
      state: 'unavailable',
      roles: [],
      detail: `${TEAM_MODULE}\n${error && error.message ? error.message : String(error)}\n`
        + 'Fix: run:\n  npm run build:lib',
      file,
    };
  }
  if (!team || typeof team.parseTeamManifest !== 'function') {
    return { state: 'unavailable', roles: [], detail: `${TEAM_MODULE} loaded but exports no parseTeamManifest`, file };
  }

  const parsed = team.parseTeamManifest(text);
  if (!parsed || parsed.ok !== true || !isPlainObject(parsed.manifest)) {
    const errors = parsed && Array.isArray(parsed.errors) ? parsed.errors : [];
    return {
      state: 'invalid',
      roles: [],
      detail: `${TEAM_RELPATH} exists and the shipped parser REFUSED it: `
        + (errors.length === 0
          ? 'no finding was recorded'
          : errors.map((e) => `${e.code} at ${e.path || '(root)'}: ${e.message}`).join('; ')),
      file,
    };
  }

  const roles = Array.isArray(parsed.manifest.roles) ? parsed.manifest.roles.filter(isPlainObject) : [];
  if (roles.length === 0) {
    return { state: 'empty', roles: [], detail: `${TEAM_RELPATH} parsed and it declares 0 roles`, file };
  }
  return { state: 'staffed', roles, detail: `${TEAM_RELPATH} declares ${count(roles.length, 'role', 'roles')}`, file };
}

/**
 * A role's binding, read off the manifest and NEVER guessed.
 *
 * `effective_binding` is the rung DISPATCH actually uses after the unknown agent
 * degrade, and it can DISAGREE with the declared binding. Both are carried,
 * because a role that declares an agent and effectively runs inline is exactly
 * the disagreement a reader needs to see, and rendering only 1 of them hides it.
 *
 * The `cli` kind is recognised here so that the day the schema grows it, this
 * reader already renders it. Recognising a shape is not accepting one: nothing
 * in this file writes a manifest, and the shipped validator is what decides
 * whether a binding is legal.
 *
 * @param {object} role a `TeamRole`
 * @returns {{kind: string, target: string|null, declared: string, effective: string|null}}
 */
function roleBinding(role) {
  const binding = isPlainObject(role) && isPlainObject(role.binding) ? role.binding : {};
  const effective = isFilledString(role && role.effective_binding) ? role.effective_binding : null;

  if (isFilledString(binding.cli)) {
    return { kind: 'cli', target: binding.cli, declared: `cli:${binding.cli}`, effective };
  }
  if (isFilledString(binding.agent)) {
    return { kind: 'agent', target: binding.agent, declared: `agent:${binding.agent}`, effective };
  }
  if (binding.inline === true) {
    return { kind: 'inline', target: null, declared: 'inline', effective };
  }
  return { kind: 'unknown', target: null, declared: 'unreadable', effective };
}

/**
 * 1 row per ROLE, with the vendor facts attached ONLY to the rows that are CLI
 * backed.
 *
 * An inline role and an agent bound role read `n/a` in the vendor columns, and
 * `n/a` is a THIRD word alongside `no` and `UNKNOWN` on purpose. `no` says the
 * measurement was made and came back negative, `UNKNOWN` says the measurement
 * was never made, and `n/a` says the measurement does not apply to this row at
 * all. Collapsing any 2 of those 3 makes a whole class of role look broken.
 *
 * @param {{roles: object[], members: object[]}} input
 * @returns {object[]} rows
 */
function buildTeamRows(input) {
  const source = isPlainObject(input) ? input : {};
  const roles = Array.isArray(source.roles) ? source.roles.filter(isPlainObject) : [];
  const members = Array.isArray(source.members) ? source.members : [];
  const byName = new Map(members.map((m) => [m.identity, m]));

  return roles.map((role) => {
    const binding = roleBinding(role);
    const vendor = binding.kind === 'cli' ? (byName.get(binding.target) || null) : null;
    return {
      role: isFilledString(role.id) ? role.id : '(unnamed role)',
      kind: binding.kind,
      binding: binding.declared,
      effective: binding.effective,
      backed_by: backingOf(binding, vendor),
      on_path: binding.kind === 'cli' ? (vendor === null ? false : vendor.on_path) : null,
      configured: binding.kind === 'cli' ? (vendor === null ? false : vendor.configured) : null,
      ready: binding.kind === 'cli' ? (vendor === null ? null : vendor.ready) : null,
      drift: binding.effective !== null && binding.kind !== 'unknown' && binding.effective !== binding.kind
        ? `DECLARED ${binding.declared} and EFFECTIVELY ${binding.effective}: dispatch degraded this role, `
          + 'so what runs is not what the manifest asked for'
        : null,
    };
  });
}

/** What actually stands behind a role, worded per rung. */
function backingOf(binding, vendor) {
  if (binding.kind === 'inline') return 'the host runtime, no separate process';
  if (binding.kind === 'agent') return `the Claude Code subagent '${binding.target}'`;
  if (binding.kind === 'cli') {
    return vendor === null
      ? `the external CLI '${binding.target}', which is NOT a dispatchable adapter identity`
      : `the external CLI '${binding.target}'`;
  }
  return 'nothing this reader could identify';
}

/* ------------------------------------------------------------------------ *
 * The vendor backends: 3 facts per identity, never collapsed.
 * ------------------------------------------------------------------------ */

/**
 * Build 1 row per crew member plus 1 row per stated exclusion.
 *
 * PURE over its arguments except for the PATH read, which is injected as a
 * resolver so every arm is drivable.
 *
 * A configured identity that is NOT in the dispatchable set still gets a row,
 * marked as such, because an identity a project declared and the engine cannot
 * dispatch is precisely the disagreement that must not be silent.
 *
 * @param {{dispatchable: string[], configured: string[], pathValue?: string,
 *          resolve?: Function, ready?: object}} input
 * @returns {{members: object[], excluded: object[], counts: object}}
 */
function buildCrew(input) {
  const source = isPlainObject(input) ? input : {};
  const dispatchable = Array.isArray(source.dispatchable) ? source.dispatchable.filter(isFilledString) : [];
  const configured = Array.isArray(source.configured) ? source.configured.filter(isFilledString) : [];
  const pathValue = typeof source.pathValue === 'string' ? source.pathValue : '';
  const resolve = typeof source.resolve === 'function' ? source.resolve : resolveOnPath;
  const ready = isPlainObject(source.ready) ? source.ready : {};

  const configuredSet = new Set(configured);
  const names = [...dispatchable];
  for (const id of configured) {
    if (!names.includes(id) && !Object.prototype.hasOwnProperty.call(CREW_EXCLUSIONS, id)) names.push(id);
  }

  const members = names.map((identity) => {
    const dispatchableHere = dispatchable.includes(identity);
    const binPath = resolve(identity, pathValue);
    const readyEntry = Object.prototype.hasOwnProperty.call(ready, identity) ? ready[identity] : null;
    return {
      identity,
      dispatchable: dispatchableHere,
      on_path: binPath !== null,
      bin_path: binPath,
      configured: configuredSet.has(identity),
      ready: readyEntry === null ? null : readyEntry.verdict,
      ready_reason: readyEntry === null ? null : readyEntry.reason,
      note: dispatchableHere
        ? null
        : `DECLARED and NOT dispatchable: the shipped adapter profile table carries no argv profile for `
          + `'${identity}', so a run that reached for it would refuse rather than dispatch`,
    };
  });

  const excluded = Object.keys(CREW_EXCLUSIONS).sort().map((identity) => ({
    identity,
    backlog: CREW_EXCLUSIONS[identity].backlog,
    reason: CREW_EXCLUSIONS[identity].reason,
    configured: configuredSet.has(identity),
  }));

  return {
    members,
    excluded,
    counts: {
      dispatchable: members.filter((m) => m.dispatchable).length,
      on_path: members.filter((m) => m.on_path).length,
      configured: members.filter((m) => m.configured).length,
      excluded: excluded.length,
    },
  };
}

/**
 * How 1 fact renders. UNKNOWN never renders as no and never renders blank.
 *
 * Every CALLER in this file passes a boolean today, because `roleMarkOf` filters
 * null out before it gets here. The null branch is therefore defence in depth,
 * and a mutation battery proved it was defence nothing watched fail: collapsing
 * it into 'no' killed no arm. It is exported and driven directly rather than left
 * as an unwatched branch, because the whole surface rests on no (measured,
 * negative) and UNKNOWN (never measured) staying 2 different words.
 */
function markOf(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return 'UNKNOWN';
}

function readyMarkOf(member) {
  if (member.ready === null || member.ready === undefined) return 'UNKNOWN';
  return String(member.ready);
}

/**
 * Render the crew as a team roster: aligned, scannable, 1 line per member with
 * every fact in its own column and the reason on the line under it.
 *
 * PURE: takes plain objects, reads no file and no clock, mutates nothing.
 *
 * @param {object} crew the value `buildCrew` returned
 * @param {{lane?: string, config_state?: string, config_detail?: string}} meta
 * @returns {string[]} lines
 */
function renderRoster(crew, meta) {
  const info = isPlainObject(meta) ? meta : {};
  const members = crew && Array.isArray(crew.members) ? crew.members : [];
  const excluded = crew && Array.isArray(crew.excluded) ? crew.excluded : [];
  const counts = crew && isPlainObject(crew.counts) ? crew.counts : {};

  const nameWidth = Math.max(12, ...members.map((m) => m.identity.length + 2), ...excluded.map((e) => e.identity.length + 2));
  const lines = renderTeamPanel(info.team_rows, {
    state: info.team_state,
    detail: info.team_detail,
  });
  lines.push('');
  lines.push(RULE);
  lines.push('BACKENDS  the vendor CLI identities a role can be backed by');
  lines.push(RULE);
  lines.push('');
  lines.push(`  ${pad('MEMBER', nameWidth)}${pad('ON PATH', 10)}${pad('CONFIGURED', 13)}${pad('READY', 12)}DISPATCHABLE`);
  lines.push(`  ${'='.repeat(nameWidth + 47)}`);

  if (members.length === 0) {
    lines.push('  EMPTY: the shipped adapter profile table yielded 0 dispatchable identities and this');
    lines.push('  project declared none either. That is a read that returned nothing, and it is not a');
    lines.push('  crew of 0 that is working fine.');
  }

  for (const m of members) {
    lines.push(`  ${pad(m.identity, nameWidth)}${pad(markOf(m.on_path), 10)}${pad(markOf(m.configured), 13)}${pad(readyMarkOf(m), 12)}${markOf(m.dispatchable)}`);
    if (m.on_path) {
      lines.push(`  ${' '.repeat(nameWidth)}resolved at ${m.bin_path}`);
    } else {
      lines.push(`  ${' '.repeat(nameWidth)}NOT ON PATH: no executable file named '${m.identity}' was found on this PATH`);
    }
    if (!m.configured) {
      lines.push(`  ${' '.repeat(nameWidth)}NOT CONFIGURED: absent from ${ADAPTERS_CONFIG_KEY}, so no run would reach for it`);
    }
    if (m.ready === null || m.ready === undefined) {
      lines.push(`  ${' '.repeat(nameWidth)}${FACT_WORDING.UNKNOWN.split('.')[0]}. Run: node scripts/fleet-crew.cjs probe`);
    } else if (m.ready_reason) {
      lines.push(`  ${' '.repeat(nameWidth)}reason: ${m.ready_reason}`);
    }
    if (m.note) lines.push(`  ${' '.repeat(nameWidth)}${m.note}`);
    lines.push('');
  }

  lines.push(RULE);
  lines.push('EXCLUDED BY POLICY, rendered rather than omitted');
  lines.push(RULE);
  for (const e of excluded) {
    lines.push(`  ${pad(e.identity, nameWidth)}${e.backlog}`);
    for (const chunk of wrapText(e.reason, 72)) lines.push(`  ${' '.repeat(nameWidth)}${chunk}`);
    if (e.configured) {
      lines.push(`  ${' '.repeat(nameWidth)}WARNING: it IS named in ${ADAPTERS_CONFIG_KEY} and it is still excluded here`);
    }
    lines.push('');
  }

  lines.push(RULE);
  lines.push('CREW SIZE');
  lines.push(RULE);
  lines.push(`  dispatchable  ${count(counts.dispatchable || 0, 'identity', 'identities')} the shipped profile table can build an invocation for`);
  lines.push(`  on path       ${count(counts.on_path || 0, 'identity', 'identities')} resolved to an executable file on this PATH`);
  lines.push(`  configured    ${count(counts.configured || 0, 'identity', 'identities')} declared in ${ADAPTERS_CONFIG_KEY}`);
  lines.push(`  excluded      ${count(counts.excluded || 0, 'identity', 'identities')} held out by stated policy, each with its reason above`);
  lines.push('');
  if (isFilledString(info.config_detail)) {
    lines.push(`  configured roster: ${info.config_detail}`);
  }
  if ((counts.configured || 0) === 0) {
    lines.push('');
    lines.push('  THE CONFIGURED CREW IS EMPTY. That is why the fleet preflight adapters check');
    lines.push('  REFUSES with empty-roster rather than reporting green: "every adapter passed" is');
    lines.push('  vacuously true of 0 adapters. Declare a crew, for example:');
    lines.push('    {"fleet": {"adapters": ["claude", "codex", "gemini"]}}');
  }
  lines.push('');
  lines.push('  THESE ARE 3 DIFFERENT FACTS AND COLLAPSING THEM HIDES A DEAD VENDOR:');
  lines.push(`    ${FACT_WORDING.ON_PATH}`);
  lines.push(`    ${FACT_WORDING.CONFIGURED}`);
  lines.push(`    ${FACT_WORDING.READY}`);
  lines.push('  This verb SPAWNED NOTHING. PATH membership was read off the filesystem, so this');
  lines.push('  listing cost 0 adapter calls. READY is measured only by the probe verb.');
  return lines;
}

/** How a vendor fact renders on a role row that is not CLI backed. */
function roleMarkOf(value) {
  if (value === null || value === undefined) return 'n/a';
  return markOf(value);
}

/**
 * The TEAM panel: 1 row per role, showing the binding and what backs it.
 *
 * PURE. Renders the ABSENT state as a named absence rather than as a blank
 * region, and renders the missing CLI binding rung as a stated gap rather than
 * as a silent omission.
 *
 * @param {object[]|null} rows the value `buildTeamRows` returned
 * @param {{state?: string, detail?: string}} meta
 * @returns {string[]} lines
 */
function renderTeamPanel(rows, meta) {
  const info = isPlainObject(meta) ? meta : {};
  const state = isFilledString(info.state) ? info.state : 'absent';
  const list = Array.isArray(rows) ? rows : [];
  const lines = [];
  lines.push(RULE);
  lines.push('TEAM  the roles this project declared, and what backs each one');
  lines.push(RULE);
  lines.push('');

  if (state !== 'staffed' || list.length === 0) {
    lines.push(`  ${state.toUpperCase()}: no role by role view could be rendered.`);
    for (const chunk of wrapText(info.detail || 'no detail recorded', 74)) lines.push(`  ${chunk}`);
    lines.push('');
    lines.push('  This is a NAMED state and not a blank panel. An ABSENT team means nobody has');
    lines.push('  written the manifest; an EMPTY team means the manifest was read and declares 0');
    lines.push('  roles; an INVALID one means the shipped parser refused it. Those are 3 different');
    lines.push('  problems with 3 different fixes, and rendering them the same way hides 2 of them.');
    lines.push('');
    lines.push('  The BACKENDS panel below still reads, because vendor availability is a fact about');
    lines.push('  this machine and this config, and it holds whether or not a team was declared.');
  } else {
    const roleWidth = Math.max(14, ...list.map((r) => r.role.length + 2));
    const bindWidth = Math.max(16, ...list.map((r) => r.binding.length + 2));
    lines.push(`  ${pad('ROLE', roleWidth)}${pad('BINDING', bindWidth)}${pad('ON PATH', 10)}${pad('CONFIGURED', 13)}${pad('READY', 10)}`);
    lines.push(`  ${'='.repeat(roleWidth + bindWidth + 33)}`);
    for (const r of list) {
      lines.push(`  ${pad(r.role, roleWidth)}${pad(r.binding, bindWidth)}${pad(roleMarkOf(r.on_path), 10)}${pad(roleMarkOf(r.configured), 13)}${pad(r.ready === null || r.ready === undefined ? (r.kind === 'cli' ? 'UNKNOWN' : 'n/a') : String(r.ready), 10)}`);
      lines.push(`  ${' '.repeat(roleWidth)}backed by ${r.backed_by}`);
      if (r.drift) {
        for (const chunk of wrapText(r.drift, 68)) lines.push(`  ${' '.repeat(roleWidth)}${chunk}`);
      }
      lines.push('');
    }
    const byKind = new Map();
    for (const r of list) byKind.set(r.kind, (byKind.get(r.kind) || 0) + 1);
    lines.push(`  ${count(list.length, 'role', 'roles')}: `
      + ['inline', 'agent', 'cli', 'unknown']
        .filter((k) => byKind.has(k))
        .map((k) => `${byKind.get(k)} ${k}`)
        .join(', '));
    lines.push('  n/a in a vendor column means the measurement does not apply to that rung, which is');
    lines.push('  a different claim from no (measured, negative) and from UNKNOWN (never measured).');
  }

  lines.push('');
  lines.push('  THE THIRD RUNG DOES NOT EXIST YET, AND THIS VIEW DID NOT ADD IT.');
  lines.push(`  The binding union at ${CLI_BINDING_GAP.file}:${CLI_BINDING_GAP.line} is ${CLI_BINDING_GAP.union}.`);
  lines.push(`  The product needs ${CLI_BINDING_GAP.missing} and it is MISSING. What it would cost:`);
  for (const chunk of wrapText(CLI_BINDING_GAP.cost, 74)) lines.push(`    ${chunk}`);
  return lines;
}

/** Wrap a sentence to a width, never breaking inside a word. */
function wrapText(text, width) {
  const words = String(text).split(/\s+/).filter((w) => w !== '');
  const out = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if ((line.length + 1 + word.length) <= width) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line !== '') out.push(line);
  return out.length === 0 ? [''] : out;
}

/* ------------------------------------------------------------------------ *
 * The probe verb. Spend gated.
 * ------------------------------------------------------------------------ */

/**
 * The 2 lanes, worded so a mock READY can never be read as a vendor READY.
 */
const LANE_WORDING = Object.freeze({
  mock: 'MOCK LANE, 0 spend. Every call ran the probe module zero spend adapter, which reaches no '
    + 'network and no model. A WIRED answer here proves the invocation build, the process seam and the '
    + 'nonce check are connected. IT PROVES NOTHING ABOUT ANY VENDOR, and this whole report therefore '
    + 'avoids the vendor readiness word entirely so that no part of it can be lifted out and read as a '
    + 'vendor result. Pass --real to measure the vendors.',
  real: 'REAL LANE, THIS SPENT MONEY. Every call went to the named vendor CLI with a nonce bearing '
    + 'prompt, and a READY here is a real measurement of that vendor on this machine.',
});

/**
 * Probe every configured member and fold the answers.
 *
 * The mock lane substitutes the ZERO SPEND identity while keeping the member's
 * name attached to the answer, so the report still reads as a crew report and
 * still says plainly which lane produced it.
 *
 * @param {{members: object[], real?: boolean, probe: object, nonce: string,
 *          run?: Function, cwd?: string}} input
 * @returns {{results: object[], lane: string}}
 */
function probeCrew(input) {
  const source = isPlainObject(input) ? input : {};
  const members = Array.isArray(source.members) ? source.members : [];
  const real = source.real === true;
  const probe = source.probe;
  const nonce = isFilledString(source.nonce) ? source.nonce : '';

  const results = members.map((m) => {
    const identity = real ? m.identity : MOCK_IDENTITY;
    const verdict = probe.runProbe({
      identity,
      nonce,
      cwd: source.cwd,
      run: source.run,
    });
    return {
      identity: m.identity,
      lane_identity: identity,
      verdict: verdict.verdict,
      reason: verdict.reason,
      bin: verdict.bin,
    };
  });
  return { results, lane: real ? 'real' : 'mock' };
}

/**
 * The MOCK lane does not report vendor readiness, so it does not print the word
 * that means vendor readiness.
 *
 * A mock run answers a genuinely useful question, "is the invocation build, the
 * process seam and the nonce check wired", and it answers NOTHING about a vendor.
 * Printing that answer in a column headed VERDICT with the value READY produces a
 * table which, read at a glance or lifted into a screenshot, is indistinguishable
 * from 3 healthy vendors. The banner above it does not travel with the table.
 *
 * So the mock lane gets its OWN column header and its OWN vocabulary. WIRED is
 * not READY, and after a mock probe every vendor's readiness is still UNKNOWN,
 * which the report states rather than leaving to be inferred.
 */
const PLUMBING_WORDING = Object.freeze({
  READY: 'WIRED',
  NOT_READY: 'NOT WIRED',
  ERROR: 'ERROR',
});

/** How 1 result renders in a lane. Never prints READY for a mock answer. */
function laneMark(verdict, lane) {
  const raw = String(verdict);
  if (lane === 'real') return raw;
  return Object.prototype.hasOwnProperty.call(PLUMBING_WORDING, raw) ? PLUMBING_WORDING[raw] : raw;
}

/** Render the probe report. PURE. */
function renderProbe(folded, meta) {
  const info = isPlainObject(meta) ? meta : {};
  const results = folded && Array.isArray(folded.results) ? folded.results : [];
  const lane = folded && folded.lane === 'real' ? 'real' : 'mock';
  const nameWidth = Math.max(12, ...results.map((r) => r.identity.length + 2));

  const lines = [];
  lines.push(RULE);
  lines.push(`FLEET CREW PROBE  ${lane === 'real' ? 'real vendors' : 'zero spend plumbing'}`);
  lines.push(RULE);
  lines.push('');
  for (const chunk of wrapText(LANE_WORDING[lane], 74)) lines.push(`  ${chunk}`);
  lines.push('');

  if (results.length === 0) {
    lines.push('  NO MEMBER WAS PROBED, because the configured crew is empty.');
    lines.push(`  ${info.config_detail || `${ADAPTERS_CONFIG_KEY} names 0 identities`}.`);
    lines.push('  0 probed is not 0 failed. Nothing was measured here at all.');
    return lines;
  }

  const header = lane === 'real' ? 'VENDOR READY' : 'PLUMBING';
  lines.push(`  ${pad('MEMBER', nameWidth)}${pad(header, 14)}${pad('LANE', 14)}REASON`);
  lines.push(`  ${'='.repeat(nameWidth + 40)}`);
  for (const r of results) {
    lines.push(`  ${pad(r.identity, nameWidth)}${pad(laneMark(r.verdict, lane), 14)}${pad(r.lane_identity, 14)}${r.reason === null ? 'answered with its nonce' : r.reason}`);
  }
  lines.push('');
  const passed = results.filter((r) => r.verdict === 'READY').length;
  if (lane === 'real') {
    lines.push(`  ${count(passed, 'member', 'members')} READY of ${count(results.length, 'probed', 'probed')}.`);
    lines.push(`  calls made: ${results.length}. spend: ${results.length} real vendor calls.`);
    return lines;
  }
  lines.push(`  ${count(passed, 'member', 'members')} WIRED of ${count(results.length, 'probed', 'probed')}.`);
  lines.push(`  VENDOR READINESS MEASURED FOR 0 of ${results.length}. Every vendor above is still`);
  lines.push('  UNKNOWN, which is not 0 ready and is not a blank: this lane never reached one.');
  lines.push(`  calls made: ${results.length}. spend: 0, every call ran the zero spend lane.`);
  return lines;
}

/* ------------------------------------------------------------------------ *
 * The assign verb. A PROJECTION.
 * ------------------------------------------------------------------------ */

/**
 * Who can actually take a node, and WHERE that answer came from.
 *
 * The TEAM is the authority when a manifest exists: every role is an executor and
 * its binding says which backend runs it. When no manifest exists the view falls
 * back to the configured vendor crew AND SAYS THAT IT FELL BACK, because a
 * projection over a fallback roster that presented itself as a team projection
 * would be the second concept beside the team that this file exists not to be.
 *
 * @param {{team: object, configured: string[], dispatchable: string[]}} input
 * @returns {{executors: object[], source: string, detail: string}}
 */
function resolveExecutors(input) {
  const source = isPlainObject(input) ? input : {};
  const team = isPlainObject(source.team) ? source.team : { state: 'absent', roles: [] };
  const configured = Array.isArray(source.configured) ? source.configured.filter(isFilledString) : [];
  const dispatchable = Array.isArray(source.dispatchable) ? source.dispatchable.filter(isFilledString) : [];

  if (team.state === 'staffed' && Array.isArray(team.roles) && team.roles.length > 0) {
    const executors = team.roles.filter(isPlainObject).map((role) => {
      const binding = roleBinding(role);
      return {
        name: isFilledString(role.id) ? role.id : '(unnamed role)',
        kind: binding.kind,
        backing: backingOf(binding, null),
      };
    });
    return {
      executors,
      source: 'team',
      detail: `${count(executors.length, 'team role', 'team roles')} read from ${TEAM_RELPATH}`,
    };
  }

  const usable = configured.filter((id) => dispatchable.includes(id));
  return {
    executors: usable.map((id) => ({ name: id, kind: 'cli', backing: `the external CLI '${id}'` })),
    source: 'fallback-adapters',
    detail: `NO TEAM MANIFEST (${team.state}), so this projection fell back to the ${ADAPTERS_CONFIG_KEY} `
      + `roster and used ${count(usable.length, 'vendor identity', 'vendor identities')}. That is a `
      + 'FALLBACK and not a team projection. It is stated here rather than presented as the same thing.',
  };
}

/**
 * Project 1 crew member onto each node of a phase graph.
 *
 * THE RULE, stated once so every rendered reason can point at it: nodes are
 * taken in the graph's own schedule order, grouped by WAVE, and inside a wave
 * they are handed to crew members in stable name order, 1 node each, restarting
 * at the first member only when the wave has more nodes than the crew has
 * members. The rotation RESETS at each wave boundary, because a wave is exactly
 * the set of nodes that run at the same time, and giving 1 member 2 nodes of the
 * same wave serializes them. When that is unavoidable the assignment SAYS SO
 * rather than hiding it, because a crew smaller than a wave is a real limit on
 * the parallelism the graph declares.
 *
 * DETERMINISTIC: the same graph and the same crew produce the same assignment on
 * every machine and every run. No clock, no randomness, no PATH reading.
 *
 * REFUSES BY NAME on an empty crew rather than rendering an empty plan. An empty
 * table reads as "there is no work", and the truth is the opposite: there is
 * work and there is nobody declared to do it.
 *
 * @param {{nodes: object[], crew: string[]}} input
 * @returns {{ok: true, assignments: object[], waves: number}
 *          |{ok: false, rule: string, code: string, message: string}}
 */
function projectAssignments(input) {
  const source = isPlainObject(input) ? input : {};
  const rawCrew = Array.isArray(source.crew) ? source.crew : [];
  const backing = new Map();
  const crew = [];
  for (const entry of rawCrew) {
    if (isFilledString(entry)) { crew.push(entry); continue; }
    if (isPlainObject(entry) && isFilledString(entry.name)) {
      crew.push(entry.name);
      backing.set(entry.name, isFilledString(entry.backing) ? entry.backing : null);
    }
  }
  const nodes = Array.isArray(source.nodes) ? source.nodes.filter(isPlainObject) : [];

  if (crew.length === 0) {
    return {
      ok: false,
      rule: EMPTY_CREW_RULE,
      code: CREW_ERROR_CODES.EMPTY_CREW,
      message: withWayOut(
        `${EMPTY_CREW_RULE}: 0 crew members are configured, so there is nobody to assign `
        + `${count(nodes.length, 'node', 'nodes')} to and no projection was computed. This REFUSES rather `
        + 'than rendering an empty assignment table, because an empty table reads as "there is no work" '
        + `and the truth is that there is work and no declared crew. Set ${ADAPTERS_CONFIG_KEY} in `
        + `${CONFIG_RELPATH}, for example {"fleet": {"adapters": ["claude", "codex", "gemini"]}}.`,
      ),
    };
  }

  const ordered = [...nodes].sort((a, b) => {
    const wa = Number.isFinite(a.wave) ? a.wave : 0;
    const wb = Number.isFinite(b.wave) ? b.wave : 0;
    if (wa !== wb) return wa - wb;
    const sa = Number.isFinite(a.schedule_order) ? a.schedule_order : 0;
    const sb = Number.isFinite(b.schedule_order) ? b.schedule_order : 0;
    if (sa !== sb) return sa - sb;
    return String(a.id).localeCompare(String(b.id));
  });

  const sortedCrew = [...crew].sort();
  const assignments = [];
  const waveSeen = new Set();
  let slot = 0;
  let currentWave = null;

  for (const node of ordered) {
    const wave = Number.isFinite(node.wave) ? node.wave : 0;
    if (wave !== currentWave) {
      currentWave = wave;
      slot = 0;
      waveSeen.add(wave);
    }
    const member = sortedCrew[slot % sortedCrew.length];
    const lap = Math.floor(slot / sortedCrew.length);
    assignments.push({
      node: String(node.id),
      wave,
      member,
      backing: backing.has(member) ? backing.get(member) : null,
      slot,
      reason: lap === 0
        ? `wave ${wave} slot ${slot} of ${sortedCrew.length} crew members, taken in stable name order, `
          + `1 node each. This node runs beside the other wave ${wave} nodes.`
        : `wave ${wave} slot ${slot}: the wave has more nodes than the crew has members, so ${member} takes `
          + `a further node on lap ${lap}. THOSE NODES SERIALIZE behind this member. A crew of `
          + `${sortedCrew.length} is the limit here, not the graph.`,
    });
    slot += 1;
  }

  return { ok: true, assignments, waves: waveSeen.size };
}

/** Render the projection. PURE. */
function renderAssign(projection, meta) {
  const info = isPlainObject(meta) ? meta : {};
  const phase = isFilledString(info.phase) ? info.phase : 'unnamed';
  const lines = [];
  lines.push(RULE);
  lines.push(`FLEET CREW ASSIGNMENT  phase ${phase}  ${PROJECTION_LABEL}`);
  lines.push(RULE);
  lines.push('');
  lines.push('  THIS SPAWNED NOTHING AND STARTED NOTHING. It shows who WOULD take which node');
  lines.push('  under the shipped work graph and the configured crew.');
  lines.push('');
  lines.push('  THE DISPATCH CONSUMER HAS LANDED AND IT STILL DOES NOT CONSUME THIS. FF-B379');
  lines.push('  closed: scripts/fleet-dispatch.cjs reads a lane manifest and drives the shipped');
  lines.push('  fleet driver. It names no role and no crew member, so it carries NO per node');
  lines.push('  adapter choice, and the engine still picks a lane by probing the machine');
  lines.push('  (FF-B233). Nothing below is handed to it. Read every row as a projection.');
  lines.push('');
  if (isFilledString(info.source_detail)) {
    lines.push(`  WHO CAN TAKE A NODE, and where that answer came from:`);
    for (const chunk of wrapText(info.source_detail, 74)) lines.push(`    ${chunk}`);
    lines.push('');
  }

  if (!projection || projection.ok !== true) {
    lines.push(`  REFUSED by rule ${projection && projection.rule ? projection.rule : 'unknown'}`);
    lines.push('');
    for (const chunk of wrapText(projection && projection.message ? projection.message : 'no reason recorded', 74)) {
      lines.push(`  ${chunk}`);
    }
    return lines;
  }

  const assignments = projection.assignments;
  if (assignments.length === 0) {
    lines.push('  EMPTY: this graph was read and it declares 0 nodes, so there is nothing to');
    lines.push('  project onto the crew. That is an empty GRAPH and not an empty crew.');
    return lines;
  }

  const nodeWidth = Math.max(8, ...assignments.map((a) => a.node.length + 2));
  const memberWidth = Math.max(13, ...assignments.map((a) => a.member.length + 2));
  const gutter = nodeWidth + memberWidth + 8;
  lines.push(`  ${pad('NODE', nodeWidth)}${pad('CREW MEMBER', memberWidth)}${pad('WAVE', 8)}WHY`);
  lines.push(`  ${'='.repeat(gutter + 40)}`);
  for (const a of assignments) {
    const chunks = wrapText(a.reason, 66);
    lines.push(`  ${pad(a.node, nodeWidth)}${pad(a.member, memberWidth)}${pad(a.wave, 8)}${chunks[0]}`);
    for (const chunk of chunks.slice(1)) lines.push(`  ${' '.repeat(gutter)}${chunk}`);
    if (isFilledString(a.backing)) {
      lines.push(`  ${' '.repeat(gutter)}executes on ${a.backing}`);
    }
  }
  lines.push('');
  const byMember = new Map();
  for (const a of assignments) byMember.set(a.member, (byMember.get(a.member) || 0) + 1);
  lines.push(`  ${count(assignments.length, 'node', 'nodes')} across ${count(projection.waves, 'wave', 'waves')}, projected onto ${count(byMember.size, 'crew member', 'crew members')}:`);
  for (const member of [...byMember.keys()].sort()) {
    lines.push(`    ${pad(member, memberWidth)}${count(byMember.get(member), 'node', 'nodes')}`);
  }
  lines.push('');
  lines.push(`  ${PROJECTION_LABEL}. Nothing above ran.`);
  return lines;
}

/** The unavailable panel. It always names WHAT could not be read. */
function unavailablePanel(title, missing) {
  const lines = [RULE, `${title}  UNAVAILABLE: nothing was read, so nothing can be said here.`, RULE];
  lines.push('  could not read:');
  for (const line of String(missing).split(/\r?\n/)) lines.push(`    ${line}`);
  lines.push('');
  lines.push('  This is a NAMED unavailable and not an empty view. An empty view says the crew');
  lines.push('  has nothing to report; this says the reader could not reach the report.');
  return lines;
}

/* ------------------------------------------------------------------------ *
 * The CLI seam. Everything above is pure or injected; all the wiring is here.
 * ------------------------------------------------------------------------ */

const USAGE = [
  'usage: node scripts/fleet-crew.cjs <verb>',
  '',
  '  roster            the crew and every fact about each member. Spawns nothing, costs 0 calls.',
  '  probe [--real]    probe each configured member. Defaults to the ZERO SPEND mock lane.',
  '                    --real SPENDS MONEY: 1 vendor call per configured member.',
  '  assign <phase>    who WOULD take which node of that phase graph. A projection, not a dispatch.',
].join('\n');

/** A nonce nothing else will contain. Used only by the probe verb. */
function mintNonce() {
  return `crew-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function main(argv) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);
  const verb = args[0];

  if (!isFilledString(verb) || verb === '--help' || verb === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return verb === undefined ? 2 : 0;
  }

  const loaded = loadProbe();
  if (loaded.ok !== true) {
    process.stdout.write(`${unavailablePanel('FLEET CREW', loaded.missing).join('\n')}\n`);
    throw new ExitError(1, loaded.code);
  }
  const probe = loaded.probe;
  const dispatchable = dispatchableIdentities(probe);
  const config = loadConfiguredRoster({ root: ROOT });

  if (verb === 'roster') {
    const crew = buildCrew({
      dispatchable,
      configured: config.adapters,
      pathValue: process.env.PATH || '',
    });
    const team = loadTeam({ root: ROOT });
    process.stdout.write(`${renderRoster(crew, {
      config_state: config.state,
      config_detail: config.detail,
      team_state: team.state,
      team_detail: team.detail,
      team_rows: buildTeamRows({ roles: team.roles, members: crew.members }),
    }).join('\n')}\n`);
    return 0;
  }

  if (verb === 'probe') {
    const real = args.includes('--real');
    const crew = buildCrew({
      dispatchable,
      configured: config.adapters,
      pathValue: process.env.PATH || '',
    });
    const members = crew.members.filter((m) => m.configured);
    if (real) {
      process.stdout.write(
        `SPEND NOTICE: the real lane is about to make ${count(members.length, 'vendor call', 'vendor calls')}, `
        + `1 per configured crew member (${members.map((m) => m.identity).join(', ') || 'none'}). `
        + 'Each is a real, billable adapter invocation. The default lane spends 0.\n\n',
      );
    }
    const folded = probeCrew({ members, real, probe, nonce: mintNonce(), cwd: ROOT });
    process.stdout.write(`${renderProbe(folded, { config_detail: config.detail }).join('\n')}\n`);
    return 0;
  }

  if (verb === 'assign') {
    const phase = args[1];
    if (!isFilledString(phase)) {
      process.stdout.write(`assign needs a phase.\n\n${USAGE}\n`);
      throw new ExitError(2, CREW_ERROR_CODES.USAGE);
    }
    let scan;
    try {
      scan = require(path.join(LIB_DIR, 'workgraph-scan.cjs'));
    } catch (error) {
      process.stdout.write(`${unavailablePanel('FLEET CREW ASSIGNMENT', `${SCAN_MODULE}\n${error && error.message ? error.message : String(error)}\nFix: run:\n  npm run build:lib`).join('\n')}\n`);
      throw new ExitError(1, CREW_ERROR_CODES.UNAVAILABLE);
    }
    const built = scan.buildWorkgraph({ cwd: ROOT, phase });

    // AN UNREADABLE GRAPH IS NOT AN EMPTY GRAPH, and the difference is the whole
    // reason this surface exists. `buildWorkgraph` REFUSES with `ok: false` and
    // still hands back `document: {}`, so a reader that checks only the shape of
    // `document` sails straight past the refusal and then renders "this graph was
    // read and it declares 0 nodes" over a graph that was never read. That
    // sentence is false, it is indistinguishable from a phase that genuinely has
    // no work, and it is the same class of lie as a green report over a dead
    // vendor. So `ok` is checked FIRST and the graph's OWN refusal message is
    // carried through intact rather than paraphrased into an emptiness.
    if (!built || built.ok !== true) {
      const why = built && isFilledString(built.message)
        ? built.message
        : `the graph for phase ${phase}${built && isFilledString(built.code) ? ` (${built.code})` : ''}`;
      process.stdout.write(`${unavailablePanel('FLEET CREW ASSIGNMENT', why).join('\n')}\n`);
      throw new ExitError(1, CREW_ERROR_CODES.UNAVAILABLE);
    }
    if (!isPlainObject(built.document) || !Array.isArray(built.document.nodes)) {
      process.stdout.write(`${unavailablePanel('FLEET CREW ASSIGNMENT', `the graph for phase ${phase} reported ok and carries no nodes array, so there is nothing this reader can believe about it`).join('\n')}\n`);
      throw new ExitError(1, CREW_ERROR_CODES.UNAVAILABLE);
    }
    const resolved = resolveExecutors({
      team: loadTeam({ root: ROOT }),
      configured: config.adapters,
      dispatchable,
    });
    const projection = projectAssignments({
      nodes: built.document.nodes,
      crew: resolved.executors,
    });
    process.stdout.write(`${renderAssign(projection, { phase, source_detail: resolved.detail }).join('\n')}\n`);
    if (projection.ok !== true) throw new ExitError(1, projection.code);
    return 0;
  }

  process.stdout.write(`unknown verb '${verb}'.\n\n${USAGE}\n`);
  throw new ExitError(2, CREW_ERROR_CODES.USAGE);
}

module.exports = {
  ADAPTERS_CONFIG_KEY,
  CLI_BINDING_GAP,
  CONFIG_RELPATH,
  CREW_ERROR_CODES,
  CREW_EXCLUSIONS,
  EMPTY_CREW_RULE,
  FACT_WORDING,
  LANE_WORDING,
  MOCK_IDENTITY,
  PLUMBING_WORDING,
  PROJECTION_LABEL,
  TEAM_RELPATH,
  USAGE,
  backingOf,
  buildCrew,
  buildTeamRows,
  dispatchableIdentities,
  loadConfiguredRoster,
  loadProbe,
  loadTeam,
  main,
  markOf,
  probeCrew,
  projectAssignments,
  renderAssign,
  renderProbe,
  renderRoster,
  renderTeamPanel,
  resolveExecutors,
  resolveOnPath,
  roleBinding,
  wrapText,
};

if (require.main === module) runMain(() => main());
