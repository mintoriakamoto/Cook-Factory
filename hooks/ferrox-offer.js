#!/usr/bin/env node
// ferrox-hook-version: {{FERROX_VERSION}}
// Ferrox Offer Hook — UserPromptSubmit
//
// The ONLY Ferrox hook that runs on what the user typed. Every other Ferrox hook
// fires after the model has already chosen an action (PreToolUse) or after the
// turn (Stop/PostToolUse), which is too late to suggest a better entry point.
//
// It is deliberately THIN. Every judgement (the 5 brakes, the registry, the copy)
// lives in ferrox-core/bin/lib/offer-registry.cjs where it is unit tested against
// synthetic state. A hook cannot be tested the way a library can, so a hook that
// contains decisions is a hook whose decisions are untested.
//
// THREE HARD RULES, because this runs on every prompt of every session:
//
//   1. NEVER BLOCK. Exit 0 on every path, including every failure. A hook that
//      breaks a session to deliver a suggestion has done more damage than the
//      suggestion could ever repay.
//   2. NEVER SPEAK TWICE. The library caps this at 1 offer per prompt and once
//      per (offer, project) forever.
//   3. YIELD TO WHOEVER OWNS THE PROJECT. If .planning/ is absent this is not a
//      Ferrox project and Ferrox says nothing, which is also how it coexists
//      with other assistants' prompt hooks without both claiming the same turn.

'use strict';

const fs = require('fs');
const path = require('path');

/** Exit without output. Used for every silent path, including every error. */
function quiet() {
  process.exit(0);
}

let input = '';
const stdinTimeout = setTimeout(quiet, 2000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('error', quiet);

process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    run();
  } catch {
    // Rule 1. A crash here must look exactly like having nothing to say.
  }
  process.exit(0);
});

function resolveLib(cwd) {
  // The library lives beside this hook in an install, and under ferrox-core in a
  // checkout. Both are tried; neither existing is a silent no-op, not an error.
  const candidates = [
    path.join(__dirname, '..', 'ferrox-core', 'bin', 'lib', 'offer-registry.cjs'),
    path.join(__dirname, '..', 'bin', 'lib', 'offer-registry.cjs'),
    path.join(cwd, 'ferrox-core', 'bin', 'lib', 'offer-registry.cjs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function run() {
  let data = {};
  try {
    data = JSON.parse(input || '{}');
  } catch {
    return;
  }

  const cwd = data.cwd || process.cwd();
  const prompt = typeof data.prompt === 'string' ? data.prompt : '';
  if (prompt === '') return;

  // Rule 3, checked before anything else touches disk or loads a module.
  if (!fs.existsSync(path.join(cwd, '.planning'))) return;

  // Opt out, honoured before any work is done.
  if (process.env.FERROX_NO_OFFERS === '1') return;

  const libPath = resolveLib(cwd);
  if (!libPath) return;
  const lib = require(libPath);
  const state = readState(cwd, libPath);
  if (state === null) return;

  const memory = lib.loadMemory(cwd);
  const decision = lib.decideOffer(prompt, state, memory);

  // Record the edge on EVERY evaluation, not only when an offer is made.
  // Otherwise a condition that becomes true while the user is mid flight stays
  // "new" forever and fires the moment they reach a seam, weeks later.
  for (const offer of lib.OFFERS) {
    memory.edges[offer.id] = lib.edgeValue(offer, state);
  }

  if (decision.offer === null) {
    lib.saveMemory(cwd, memory);
    return;
  }

  memory.outcomes[decision.offer.id] = 'shown';
  lib.saveMemory(cwd, memory);
  lib.logDecision(cwd, {
    offer: decision.offer.id,
    outcome: 'shown',
    situation: state.situation,
    at: new Date().toISOString(),
  });

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        `<ferrox-offer id="${decision.offer.id}">\n${decision.text}\n`
        + 'Offer this to the user in your own words, once, then do what they ask. '
        + 'If they decline or ignore it, do not raise it again.\n'
        + '</ferrox-offer>',
    },
  }));
}

/** Read the project state the registry needs. Returns null if unreadable. */
function readState(cwd, libPath) {
  try {
    const libDir = path.dirname(libPath);
    const smart = require(path.join(libDir, 'smart-entry.cjs'));
    const signals = smart.detectSignals(cwd);
    const situation = smart.classify(signals);
    return {
      situation,
      hasPlanning: signals.has_planning,
      hasRoadmap: signals.has_roadmap && (signals.total_phases || 0) > 0,
      disjointPlans: countDisjointPlans(cwd, signals.current_phase),
      fleetAvailable: fleetLooksRunnable(cwd, libDir),
      unpushedCommits: signals.git_unpushed ? 1 : 0,
      dirty: signals.git_dirty,
    };
  } catch {
    return null;
  }
}

/**
 * How many plans in the current phase declare write lanes that overlap nobody.
 *
 * Cheap on purpose: one directory read plus a frontmatter slice per plan, no
 * YAML parser and no work graph. A prompt hook has roughly a 100ms budget, and
 * the exact number does not matter here; the offer only asks whether the SHAPE
 * of the work is parallel, and the real overlap check runs again inside the
 * dispatcher before anything is minted.
 *
 * Returns 0 on anything unreadable. 0 means "no offer", which is the safe
 * direction: an unknown count must never be read as a parallel one.
 */
function countDisjointPlans(cwd, currentPhase) {
  try {
    if (currentPhase === null || currentPhase === undefined) return 0;
    const phasesDir = path.join(cwd, '.planning', 'phases');
    if (!fs.existsSync(phasesDir)) return 0;
    const token = String(currentPhase);
    const dir = fs.readdirSync(phasesDir)
      .find((d) => d === token || d.startsWith(`${token}-`));
    if (!dir) return 0;

    const planDir = path.join(phasesDir, dir);
    const plans = fs.readdirSync(planDir).filter((f) => /PLAN\.md$/.test(f));
    if (plans.length < 2) return 0;

    const lanes = [];
    for (const f of plans) {
      const text = fs.readFileSync(path.join(planDir, f), 'utf-8');
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fm) continue;
      const m = fm[1].match(/^files_modified:\s*\[([^\]]*)\]/m);
      if (!m) continue;
      const files = m[1].split(',').map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter((x) => x !== '');
      if (files.length > 0) lanes.push(new Set(files));
    }
    if (lanes.length < 2) return 0;

    // A lane is disjoint when it shares no file with ANY other lane.
    let disjoint = 0;
    for (let i = 0; i < lanes.length; i += 1) {
      let clashes = false;
      for (let j = 0; j < lanes.length && !clashes; j += 1) {
        if (i === j) continue;
        for (const f of lanes[i]) {
          if (lanes[j].has(f)) { clashes = true; break; }
        }
      }
      if (!clashes) disjoint += 1;
    }
    return disjoint;
  } catch {
    return 0;
  }
}

/**
 * Whether a fleet could plausibly run here, without paying to find out.
 *
 * The authority on this is `detectWorkflowBackend`, which is far too expensive
 * for a prompt hook. This is a deliberately conservative PROXY over the 2
 * conditions that actually strand people: the fleet entry point has to be
 * installed (it was not, for the whole of 1.14.0), and the project must not have
 * pinned itself to inline execution.
 *
 * A false NEGATIVE here costs one un-made offer. A false positive would offer
 * something that refuses on acceptance, which brake 5 exists to prevent, so the
 * proxy is built to fail toward silence.
 */
function fleetLooksRunnable(cwd, libDir) {
  try {
    const runtimeRoot = path.dirname(path.dirname(libDir)); // .../ferrox-core
    const entry = path.join(path.dirname(runtimeRoot), 'scripts', 'fleet-dispatch.cjs');
    if (!fs.existsSync(entry)) return false;

    const cfgPath = path.join(cwd, '.planning', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const backend = cfg
        && cfg.claude_orchestration
        && cfg.claude_orchestration.execution_backend;
      if (backend === 'inline') return false;
    }
    return true;
  } catch {
    return false;
  }
}
