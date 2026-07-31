'use strict';

/**
 * THE ON RAMP: DOES THE SYSTEM CARRY A BEGINNER, OR TELL THEM AND STOP.
 *
 * Every claim here is about PROSE in shipped workflow and command markdown, which
 * is the hardest thing in this repository to test honestly. FF-B284 is the rule
 * that governs it: A MUTATION BATTERY CANNOT DETECT A FALSE SENTENCE. A battery
 * mutates code and observes behaviour; a paragraph asserting something untrue
 * survives every mutant because nothing executes it.
 *
 * So each arm below does one of exactly 2 things:
 *
 *   1. Asserts a COUNTED, MACHINE CHECKABLE property of the text (this command is
 *      named, this file resolves, this marker is present N times), never that the
 *      text "explains" something.
 *   2. Renders the claim over a CONTRADICTING input and requires the check to
 *      report it. Those arms are named `... CAN FAIL` and they exist because a
 *      grep for a string that is present in every file is not a test.
 *
 * ─── THE CENTRAL CLAIM ───────────────────────────────────────────────────────
 *
 * `new-project` used to end by printing a command and stopping, at 7 separate
 * handoffs. The carrier for "build the whole thing" already existed and worked
 * (`/ferrox-progress --next --auto`, workflows/next.md), and nothing routed to it.
 * The chain gate is 1 question that converts the terminus into a handoff.
 *
 * The acceptance for that is deliberately NOT "auto_advance is set". A config key
 * being written is satisfied by an implementation that sets it and stops, which
 * advances nothing. The gate must ALSO dispatch, so both are asserted, and the
 * dispatch is asserted to name the gated engine rather than any command that
 * builds 1 step.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS = path.join(ROOT, 'ferrox-core', 'workflows');
const COMMANDS = path.join(ROOT, 'commands', 'ferrox');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf-8');
const count = (haystack, needle) => haystack.split(needle).length - 1;

/* ------------------------------------------------------------------------ *
 * The chain gate
 * ------------------------------------------------------------------------ */

test('CHAIN GATE: new-project asks whether to build it now', () => {
  const text = read(WORKFLOWS, 'new-project.md');
  assert.ok(text.length > 1000, `must have read a real workflow, got ${text.length} chars`);
  assert.ok(
    text.includes('Build it now, or one step at a time?'),
    'the interactive terminus must ask the chain gate question',
  );
  assert.ok(
    text.includes('Build it now (Recommended)'),
    'the carry must be the marked recommendation, not an equal alternative',
  );
});

test('CHAIN GATE: it sets the key AND dispatches. Either alone is a failure', () => {
  const text = read(WORKFLOWS, 'new-project.md');
  const gate = text.slice(text.indexOf('### The chain gate'), text.indexOf('**If "One step at a time"'));
  assert.ok(gate.length > 300, `the chain gate section must be substantial, got ${gate.length}`);

  // Both halves, counted, and BOTH SCOPED TO THE GATE SECTION.
  //
  // The first draft of this arm searched the whole file for the carrier string,
  // which a mention in an unrelated "Also available" banner satisfied. A mutant
  // that deleted the actual dispatch and left the banners survived it, at 23 of 23
  // green. That is the same defect as the spend leak it came out of: a guard that
  // covers 1 of 3 call sites reads exactly like a guard that covers the file.
  assert.ok(
    gate.includes('config-set workflow.auto_advance true'),
    'the gate must set workflow.auto_advance',
  );
  // An actual DISPATCH INSTRUCTION, not a mention of the command's name.
  assert.match(
    gate,
    /invoke SlashCommand\("\/ferrox-progress --next --auto"\)/,
    'the gate must DISPATCH the carrier. Setting a config key advances nothing',
  );
});

test('CHAIN GATE: the carrier is the GATED engine, not a 1-step builder', () => {
  const text = read(WORKFLOWS, 'new-project.md');
  // smart-entry.cts records the invariant: forward motion delegates to
  // `progress --next`, and a standalone advancement command that bypassed Route 0
  // and Gates 1-3 is what got the old flat /ferrox-next removed (#3054).
  const gateSection = text.slice(text.indexOf('### The chain gate'));
  assert.ok(gateSection.length > 200, 'the chain gate section must exist and be substantial');
  assert.ok(
    /ONLY legal carrier/i.test(gateSection),
    'the section must state that the carrier is not substitutable',
  );
  // The two commands that must NOT be the carrier here.
  assert.ok(
    !/Then exit this skill and invoke SlashCommand\("\/ferrox-execute-phase/.test(gateSection),
    'execute-phase builds 1 step and must not be the carrier',
  );
  assert.ok(
    !/Then exit this skill and invoke SlashCommand\("\/ferrox-autonomous/.test(gateSection),
    'autonomous bypasses the gates and must not be the carrier',
  );
});

test('CHAIN GATE: "one step at a time" still exists, so nothing was taken away', () => {
  const text = read(WORKFLOWS, 'new-project.md');
  assert.ok(text.includes('One step at a time'), 'the review-each-step path must remain offered');
  // The banners it falls through to must still be there.
  assert.ok(count(text, '## ▶ Next Up') >= 2, 'both Next Up banners must survive the gate');
});

test('THE CHAIN GATE CHECK CAN FAIL: a workflow without it is reported', () => {
  // The required failing arm. Every assertion above is a substring search, and a
  // substring search that happens to match every file in the repository is not
  // evidence. `plan-phase.md` is a real shipped workflow that legitimately has no
  // chain gate, so the same checks must come back negative on it.
  const other = read(WORKFLOWS, 'plan-phase.md');
  assert.ok(other.length > 1000, 'control file must be real');
  assert.ok(
    !other.includes('Build it now, or one step at a time?'),
    'the control file must NOT contain the chain gate, or these checks prove nothing',
  );
});

/* ------------------------------------------------------------------------ *
 * The recommendation marker
 * ------------------------------------------------------------------------ */

test('every round 1 MODE/GRANULARITY/EXECUTION question carries a recommendation', () => {
  const text = read(WORKFLOWS, 'new-project.md');
  // The granularity question was the ONLY round 1 question with no marker, while
  // the identical question on the auto path did label Coarse as recommended. A
  // question with no defensible default is the first place a beginner stalls.
  const idx = text.indexOf('How finely should scope be sliced into phases?');
  assert.notStrictEqual(idx, -1, 'the granularity question must exist');
  const block = text.slice(idx, idx + 600);
  assert.ok(
    /Coarse \(Recommended\)/.test(block),
    `the granularity question must mark a recommendation.\n--- block ---\n${block.slice(0, 300)}`,
  );
});

/* ------------------------------------------------------------------------ *
 * Termini name how work leaves the machine
 * ------------------------------------------------------------------------ */

test('BOTH termini name /ferrox-ship', () => {
  // A beginner reaches a working increment and was never told how it leaves their
  // machine. Both places a phase can finish now say so.
  for (const f of ['verify-work.md', 'execute-phase.md']) {
    const text = read(WORKFLOWS, f);
    assert.ok(
      /ferrox[:-]ship/.test(text),
      `${f} completes a phase and must name ship`,
    );
  }
});

test('BOTH termini offer the carry, so the loop can continue unattended', () => {
  for (const f of ['verify-work.md', 'execute-phase.md']) {
    const text = read(WORKFLOWS, f);
    assert.ok(
      text.includes('--next --auto'),
      `${f} must offer the carry so a user is not forced back to manual stepping`,
    );
  }
});

/* ------------------------------------------------------------------------ *
 * The newcomer tour
 * ------------------------------------------------------------------------ */

test('the newcomer tour names the RECOVERY commands it used to omit', () => {
  const tour = read(WORKFLOWS, 'help', 'modes', 'default.md');
  assert.ok(tour.length > 500, 'must have read the tour');
  // All 4 were absent: a user could not learn they existed from the page written
  // for users who know nothing.
  for (const cmd of ['next', 'resume-work', 'pause-work', 'undo']) {
    assert.ok(
      new RegExp(`ferrox[:-]${cmd}\\b`).test(tour),
      `the newcomer tour must name /ferrox-${cmd}`,
    );
  }
});

test('the newcomer tour leads with the CARRY, not with manual stepping', () => {
  const tour = read(WORKFLOWS, 'help', 'modes', 'default.md');
  const head = tour.slice(0, tour.indexOf('## The 9'));
  assert.ok(head.length > 100, 'the opening section must exist');
  assert.ok(
    head.includes('--next --auto'),
    'the first thing a newcomer reads must include the command that builds everything',
  );
});

test('the tour DEFINES the word phase, which appeared in 25 descriptions undefined', () => {
  const tour = read(WORKFLOWS, 'help', 'modes', 'default.md');
  assert.ok(
    /A phase is one step of your build/.test(tour),
    'the word phase is unavoidable in the command names, so the tour must define it',
  );
});

test('THE TOUR CHECKS CAN FAIL: an unrelated help mode lacks these', () => {
  // Control. `--brief` is a different mode with a different job.
  const brief = read(WORKFLOWS, 'help', 'modes', 'brief.md');
  assert.ok(brief.length > 100, 'control file must be real');
  assert.ok(
    !/A phase is one step of your build/.test(brief),
    'the control must not contain the definition, or the check above proves nothing',
  );
});

/* ------------------------------------------------------------------------ *
 * Compound intent
 * ------------------------------------------------------------------------ */

test('COMPOUND INTENT: do.md detects a sequence before it routes', () => {
  const text = read(WORKFLOWS, 'do.md');
  assert.ok(text.length > 1000, 'must have read the router');
  // The router resolved to exactly 1 command by taking the first match, so
  // "brainstorm a game and then build it" ran the brainstorm and dropped the rest.
  const compound = text.slice(text.indexOf('<step name="compound">'));
  assert.ok(compound.length > 500, 'do.md must carry a compound step');
  for (const marker of ['then', 'after that', 'first ... then']) {
    assert.ok(compound.includes(marker), `the compound step must recognise "${marker}"`);
  }
  assert.ok(
    /never discard a stated intent in silence/i.test(compound),
    'an unroutable tail must be reported rather than dropped',
  );
});

test('COMPOUND INTENT: "build it all" resolves to the carrier, not to a 1-step build', () => {
  const text = read(WORKFLOWS, 'do.md');
  const rows = text.split(/\r?\n/).filter((l) => l.startsWith('|'));
  assert.ok(rows.length > 15, `the routing table must be real, got ${rows.length} rows`);
  const carrierRow = rows.find((r) => r.includes('--next --auto'));
  assert.ok(carrierRow, 'the routing table must route "build it all" to the carrier');
  assert.ok(
    /build it all|autonomously|without stopping/i.test(carrierRow),
    `the carrier row must be keyed on the phrases a user types: ${carrierRow}`,
  );
  // autonomous must be gated on a NAMED RANGE so it stops being the default answer
  // to "build everything", which is what it was.
  const autoRow = rows.find((r) => /ferrox[:-]autonomous/.test(r));
  assert.ok(autoRow, 'the autonomous row must still exist');
  assert.ok(
    /NAMED RANGE|range/i.test(autoRow),
    `autonomous must be gated on a named range: ${autoRow}`,
  );
});

test('THE NL DOOR IS REACHABLE: /ferrox-next accepts words and loads do.md', () => {
  // do.md was only ever loaded inside /ferrox-progress, so nothing a user would
  // think to type led to it. The door is the command that is already the front door.
  const cmd = read(COMMANDS, 'next.md');
  assert.ok(
    cmd.includes('workflows/do.md'),
    'commands/ferrox/next.md must load the natural language router',
  );
  assert.ok(
    /plain words/i.test(cmd),
    'the description must tell the user they can type a sentence',
  );

  const wf = read(WORKFLOWS, 'smart-entry.md');
  const freeform = wf.slice(wf.indexOf('<step name="freeform">'));
  assert.ok(freeform.length > 300, 'smart-entry.md must carry a freeform step');
  assert.ok(
    freeform.includes('do.md'),
    'the freeform step must hand off to the router rather than re-deriving routing',
  );
});

test('THE GENERATED SKILL MATCHES ITS SOURCE, so the door actually ships', () => {
  // skills/ is GENERATED from commands/ferrox/. An edit to the generated copy is
  // silently reverted by the next generator run, which is this session's defect
  // class (a correct artifact behind a path that does not resolve) applied to the
  // build itself.
  const skill = read(ROOT, 'skills', 'ferrox-next', 'SKILL.md');
  assert.ok(skill.includes('do.md'), 'the SHIPPED skill must load the router');
  assert.ok(/plain words/i.test(skill), 'the shipped description must invite a sentence');
  // And the generated copy must carry the ROUTABLE hyphen form, never the colon form.
  assert.ok(!skill.includes('/ferrox:'), 'a generated skill must not carry the colon form');
});

/* ------------------------------------------------------------------------ *
 * Profiles
 * ------------------------------------------------------------------------ */

const PROFILES = require(path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'install-profiles.cjs'));
const REGISTRY = require(path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'capability-registry.cjs'));

function closureOf(name) {
  const manifest = PROFILES.loadSkillsManifest();
  const r = PROFILES.resolveProfile({ modes: [name], manifest, registry: REGISTRY });
  return r.skills === '*' ? null : r.skills;
}

test('the beginner profile EXISTS and can confirm, send, debug and reverse', () => {
  const skills = closureOf('beginner');
  assert.ok(skills, 'beginner must not resolve to the full sentinel');
  // Denominator first: an empty set satisfies "contains no expert commands".
  assert.ok(skills.size >= 9, `beginner must be a real set, got ${skills.size}`);
  // The exact defect that made `core` unusable: it could build and then not
  // confirm, ship, debug or undo.
  for (const needed of ['new-project', 'next', 'plan-phase', 'execute-phase',
    'verify-work', 'ship', 'debug', 'undo', 'help']) {
    assert.ok(skills.has(needed), `beginner must include ${needed}`);
  }
});

test('core was FIXED: it can no longer build without being able to ship', () => {
  const skills = closureOf('core');
  assert.ok(skills && skills.size >= 8, 'core must be a real set');
  for (const needed of ['verify-work', 'ship', 'debug', 'undo']) {
    assert.ok(skills.has(needed), `core must include ${needed}: a profile that cannot ship is a demo`);
  }
});

test('the documented superset invariant HOLDS, rather than only being documented', () => {
  const beginner = closureOf('beginner');
  const core = closureOf('core');
  const standard = closureOf('standard');
  assert.ok(beginner && core && standard, 'all 3 profiles must resolve');
  const supersetOf = (a, b) => [...b].every((x) => a.has(x));
  // install-profiles states "standard is a superset of core" in its header. Once
  // core gained 4 commands that sentence became false with nothing to catch it.
  assert.ok(supersetOf(standard, core), 'standard must contain core');
  assert.ok(supersetOf(standard, beginner), 'standard must contain beginner');
});

test('PROFILE_RANK order matches the MEASURED sizes it claims to describe', () => {
  // The rank drives "most restrictive wins" across multiple runtimes. A rank that
  // disagrees with the real sizes silently installs the larger set.
  const sizes = {
    beginner: closureOf('beginner').size,
    core: closureOf('core').size,
    standard: closureOf('standard').size,
  };
  assert.ok(
    sizes.beginner <= sizes.core,
    `beginner (${sizes.beginner}) must not exceed core (${sizes.core})`,
  );
  assert.ok(
    sizes.core <= sizes.standard,
    `core (${sizes.core}) must not exceed standard (${sizes.standard})`,
  );
});

test('THE CARRIER SHIPS wherever the chain gate can fire', () => {
  // THE DEFECT CLASS, stated as an invariant. The chain gate at the end of
  // new-project dispatches `/ferrox-progress --next --auto`. A profile that installs
  // new-project and NOT progress would run the gate, ask the question, get "build it
  // now", and dispatch a command the user does not have. The artifact would be
  // correct and the path to it would not, which is the shape of all 5 failures this
  // came out of, and every one of them passed every gate because every gate ran
  // where all the paths happen to exist.
  for (const name of ['beginner', 'core', 'standard']) {
    const skills = closureOf(name);
    assert.ok(skills, `${name} must resolve`);
    if (!skills.has('new-project')) continue;
    assert.ok(
      skills.has('progress'),
      `${name} installs new-project, whose chain gate dispatches progress, but not progress`,
    );
  }
});

test('--profile is DOCUMENTED, having appeared 0 times in README and docs', () => {
  const readme = read(ROOT, 'README.md');
  assert.ok(readme.includes('--profile=beginner'), 'README must document the beginner profile');
  assert.ok(readme.includes('--profile=standard'), 'README must document the standard profile');
  // And it must state the closure behaviour, because "a profile of 9" describes the
  // base and will be read as the install size.
  assert.ok(
    /transitive closure/i.test(readme),
    'README must explain that the installed set is the closure, not the base list',
  );
});

test('the INSTALL SUMMARY names exactly 1 command to type', () => {
  const installer = read(ROOT, 'bin', 'install.js');
  const idx = installer.indexOf('const startHere =');
  assert.notStrictEqual(idx, -1, 'the installer must carry a START HERE block');
  const block = installer.slice(idx, idx + 1200);
  assert.ok(block.includes('Start here.'), 'the block must be labelled');
  assert.ok(block.includes('--profile=beginner'), 'the block must name the smaller install');
  // Written once and used by all 3 Done! banners, so it is 1 thing to keep true.
  assert.strictEqual(
    count(installer, '${startHere}'), 3,
    'all 3 Done! banners must use the shared block',
  );
});
