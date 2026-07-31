'use strict';

/**
 * Phase 14.1 (v1.14 Fleet Mode): the governance-file contract.
 *
 * On 2026-07-25 `.planning/STATE.md` carried `milestone: v1.14` in its frontmatter while
 * its body pointed an agent at the v1.1 milestone. The declaration was correct and the
 * body was a lie, so a declaration-equality check passes that file green. These tests
 * lock the properties that make the governance gate mean something:
 *
 *   - HERMETIC: no clock, no git, no filesystem inside the lib. The caller passes file
 *     bytes in; the lib never reads the disk.
 *   - FAIL LOUD: a malformed input returns `{ok:false, code}` and is never silently
 *     skipped. A silently skipped file is exactly how a governance file rots while
 *     looking healthy.
 *   - A CORRECT DECLARATION OVER A STALE BODY MUST FAIL. That property is the entire
 *     reason this phase exists, and it is what a declaration-equality check cannot see.
 *
 * The versionless blind spot of `detectStaleClaims` is pinned by a test rather than
 * discovered later: 3 of the 4 drifts observed in the state file on 2026-07-25 named no
 * version at all, which is why `checkStateStructure` and not the version check is what
 * protects `STATE.md`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB_PATH = path.join(__dirname, '..', 'ferrox-core', 'bin', 'lib', 'governance-manifest.cjs');
const lib = require(LIB_PATH);

const ACTIVE = '1.14';

/** The declaration line `.planning/ROADMAP.md` line 3 already carries, verbatim. */
const ROADMAP_LINE_3 = '> **Scope: milestone v1.14 (Fleet Mode).** Rewritten 2026-07-25. The previous contents';

function group(milestone, name, lifecycle) {
  return { milestone, name, lifecycle, shipped: [], artifact_kind: 'milestone', parts: [], progress: { done: 0, total: 0 } };
}

// ---------------------------------------------------------------------------
// parseScopeDeclaration (D2, SC2): visible human prose, never a hidden label
// ---------------------------------------------------------------------------

test('parseScopeDeclaration reads a bolded scope sentence', () => {
  const r = lib.parseScopeDeclaration(
    '# Roadmap\n\n**Scope: milestone v1.14 (Fleet Mode).** Rewritten 2026-07-25.\n',
    'ROADMAP.md',
  );
  assert.equal(r.ok, undefined, 'a well-formed declaration is not an error object');
  assert.equal(r.version, '1.14');
  assert.equal(r.name, 'Fleet Mode');
});

test('parseScopeDeclaration reads the blockquote-prefixed line ROADMAP.md already carries', () => {
  const r = lib.parseScopeDeclaration(`# Roadmap: Ferrox Factory\n\n${ROADMAP_LINE_3}\n`, 'ROADMAP.md');
  assert.equal(
    r.version,
    '1.14',
    'the form was chosen BECAUSE a human already wrote it at .planning/ROADMAP.md line 3; a parser that needs that file edited has picked the wrong form',
  );
  assert.equal(r.name, 'Fleet Mode');
});

test('parseScopeDeclaration finds a declaration anywhere in the first 40 lines', () => {
  const filler = Array.from({ length: 20 }, (_, i) => `filler ${i}`).join('\n');
  const r = lib.parseScopeDeclaration(`${filler}\n**Scope: milestone v1.9 (The Gate Library).**\n`, 'PROJECT.md');
  assert.equal(r.version, '1.9');
});

test('parseScopeDeclaration ignores a declaration past line 40, so a buried label cannot count', () => {
  const filler = Array.from({ length: 60 }, (_, i) => `filler ${i}`).join('\n');
  const r = lib.parseScopeDeclaration(`${filler}\n**Scope: milestone v1.9 (The Gate Library).**\n`, 'PROJECT.md');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_GOV_SCOPE_MISSING');
});

test('a missing declaration FAILS LOUD rather than being treated as compliant', () => {
  const r = lib.parseScopeDeclaration('# Roadmap\n\nSome prose with no declaration.\n', 'ROADMAP.md');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_GOV_SCOPE_MISSING');
  assert.equal(r.file, 'ROADMAP.md');
});

test('a half-written declaration is MALFORMED, never silently missing', () => {
  const r = lib.parseScopeDeclaration('**Scope: milestone Fleet Mode.**\n', 'ROADMAP.md');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_GOV_SCOPE_MALFORMED', 'a declaration that names Scope but no version must not degrade to MISSING');
});

test('a declaration naming a version other than the active milestone MISMATCHES, and says both', () => {
  const r = lib.parseScopeDeclaration('**Scope: milestone v1.1 (Reach and Triage).**\n', 'ROADMAP.md', ACTIVE);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_GOV_SCOPE_MISMATCH');
  assert.match(r.message, /1\.1/, 'the message must name the declared version');
  assert.match(r.message, /1\.14/, 'the message must name the active version');
});

test('a declaration naming the active milestone passes the mismatch check', () => {
  const r = lib.parseScopeDeclaration(`${ROADMAP_LINE_3}\n`, 'ROADMAP.md', ACTIVE);
  assert.equal(r.version, '1.14');
});

test('no HTML comment marker is emitted or accepted, because D2 forbids a hidden machine label', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'governance-manifest.cts'), 'utf8');
  assert.equal(
    /ferrox:roadmap-scope/.test(src),
    false,
    'a hidden marker can be bumped to appease CI while the prose rots; that reproduces the original failure at smaller scale',
  );
});

// ---------------------------------------------------------------------------
// detectStaleClaims: the prose-file half, and its stated blind spot
// ---------------------------------------------------------------------------

test('detectStaleClaims flags a current-focus line naming a superseded milestone', () => {
  const errors = lib.detectStaleClaims('# X\n\n**Current focus:** v1.1 "Reach and Triage"\n', 'PROJECT.md', ACTIVE);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'E_GOV_STALE_BODY');
  assert.equal(errors[0].line, 3, 'the error must carry the 1-based line number of the offending line');
  assert.match(errors[0].text, /Current focus/);
});

test('detectStaleClaims flags a resume pointer naming a superseded milestone artifact', () => {
  const errors = lib.detectStaleClaims('Resume file: .planning/MILESTONE-v1.1-REACH.md', 'STATE.md', ACTIVE);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'E_GOV_STALE_BODY');
});

test('detectStaleClaims returns zero when the same claim lines name the active milestone', () => {
  const text = '**Current focus:** v1.14 "Fleet Mode"\nResume file: .planning/MILESTONE-v1.14-FLEET-MODE.md\n';
  assert.deepEqual(lib.detectStaleClaims(text, 'PROJECT.md', ACTIVE), []);
});

test('detectStaleClaims leaves a retained-for-history heading alone', () => {
  assert.deepEqual(
    lib.detectStaleClaims('### Decisions (v1.1, retained for history)', 'STATE.md', ACTIVE),
    [],
    'the check must not achieve its result by flagging every mention of an old version',
  );
});

test('KNOWN LIMITATION, pinned deliberately: detectStaleClaims cannot see a versionless claim', () => {
  assert.deepEqual(
    lib.detectStaleClaims('Status: awaiting execution', 'STATE.md', ACTIVE),
    [],
    'this line is FALSE and this function returns zero on it. 3 of the 4 drifts observed on 2026-07-25 had this shape. checkStateStructure is what protects STATE.md; a prose-bearing file watched only by this function is NOT protected against versionless drift',
  );
  assert.deepEqual(
    lib.detectStaleClaims('Plan: 14-01 planned, awaiting execution', 'STATE.md', ACTIVE),
    [],
    'a hyphenated plan id is not a dotted milestone version, so this line is invisible here too',
  );
});

test('the versionless limitation is stated in the source header, not only in the plan', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'governance-manifest.cts'), 'utf8');
  assert.match(src, /versionless/i, 'a future reader must not be able to conclude a prose file is safe because this function watches it');
});

test('CURRENT_STATE_CLAIM_PATTERNS is frozen and inspectable, so narrowing it is visible', () => {
  assert.equal(Object.isFrozen(lib.CURRENT_STATE_CLAIM_PATTERNS), true);
  assert.ok(lib.CURRENT_STATE_CLAIM_PATTERNS.length >= 10, 'the live defect used current focus and resume file; their siblings in the state template are covered too');
  const joined = lib.CURRENT_STATE_CLAIM_PATTERNS.map((r) => r.source).join('|');
  for (const label of ['current focus', 'resume file', 'last activity', 'last session']) {
    assert.match(joined, new RegExp(label.replace(' ', '\\\\s\\+')), `claim label missing: ${label}`);
  }
});

// ---------------------------------------------------------------------------
// resolveShippedIn (SC6) and activeVersionOf (D1)
// ---------------------------------------------------------------------------

test('resolveShippedIn accepts a pointer naming a real milestone version', () => {
  const groups = [group('1.13', 'Merge Gate', 'complete'), group('1.14', 'Fleet Mode', 'active')];
  assert.deepEqual(lib.resolveShippedIn([{ id: 'R5', shipped_in: '1.13' }], groups), []);
});

test('resolveShippedIn accepts the literal pending', () => {
  const groups = [group('1.14', 'Fleet Mode', 'active')];
  assert.deepEqual(lib.resolveShippedIn([{ id: 'R9', shipped_in: 'pending' }], groups), []);
});

test('resolveShippedIn rejects a pointer that resolves to no real milestone', () => {
  const groups = [group('1.14', 'Fleet Mode', 'active')];
  const errors = lib.resolveShippedIn([{ id: 'R7', shipped_in: '1.99' }], groups);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'E_GOV_SHIPPED_IN_UNRESOLVED');
  assert.match(errors[0].message, /R7/);
});

test('resolveShippedIn enforces ONE direction only, so an unclaimed shipped milestone is not an error', () => {
  const groups = [group('1.12', 'Prior', 'complete'), group('1.14', 'Fleet Mode', 'active')];
  assert.deepEqual(
    lib.resolveShippedIn([{ id: 'R1', shipped_in: '1.14' }], groups),
    [],
    'the reverse direction is deliberately unenforced; a legitimate state would go red, per the asymmetry note in scripts/gen-milestones.cjs',
  );
});

test('activeVersionOf returns the single active milestone version', () => {
  const groups = [group('1.13', 'Merge Gate', 'complete'), group('1.14', 'Fleet Mode', 'active')];
  assert.equal(lib.activeVersionOf(groups), '1.14');
});

test('activeVersionOf returns null for zero active and for multiple active, so the CALLER owns the message', () => {
  assert.equal(lib.activeVersionOf([group('1.13', 'Merge Gate', 'complete')]), null);
  assert.equal(lib.activeVersionOf([group('1.13', 'A', 'active'), group('1.14', 'B', 'active')]), null);
  assert.equal(lib.activeVersionOf([]), null);
});

test('activeVersionOf consumes the shipped resolver rather than reimplementing it (D1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'governance-manifest.cts'), 'utf8');
  assert.match(src, /milestone-manifest\.cjs/, 'D1 is already shipped at src/milestone-manifest.cts:305-309; a second resolver is the defect');
  assert.equal(
    /lifecycle\s*===\s*'active'/.test(src),
    false,
    'filtering on lifecycle here would BE the second resolver',
  );
});

// ---------------------------------------------------------------------------
// HERMETIC BY CONTRACT
// ---------------------------------------------------------------------------

test('the built lib is hermetic: no filesystem, no child process, no wall clock', () => {
  const built = fs.readFileSync(LIB_PATH, 'utf8');
  assert.equal(/require\(["'](?:node:)?fs["']\)/.test(built), false, 'no filesystem require');
  assert.equal(/require\(["'](?:node:)?child_process["']\)/.test(built), false, 'no child process require');
  assert.equal(/require\(["'](?:node:)?path["']\)/.test(built), false, 'no path require; the caller owns paths');
  assert.equal(/Date\.now\(/.test(built), false, 'no wall clock read');
  assert.equal(/new Date\(/.test(built), false, 'no wall clock read');
});

test('every exported function returns rather than throws on hostile input', () => {
  for (const fn of ['parseScopeDeclaration', 'detectStaleClaims', 'checkStateStructure']) {
    assert.doesNotThrow(() => lib[fn](null, undefined, undefined), `${fn} must never throw`);
    assert.doesNotThrow(() => lib[fn]('', '', ''), `${fn} must never throw`);
  }
  assert.doesNotThrow(() => lib.resolveShippedIn(null, null));
  assert.doesNotThrow(() => lib.activeVersionOf(null));
});

// ---------------------------------------------------------------------------
// checkStateStructure (D3d): the guard that has nowhere for a claim to live
//
// STATE.md is not generated and not byte compared, because src/state.cts:1661
// re-injects a wall clock on every write and 18 state subcommands mutate the file.
// Instead the file is made structurally incapable of carrying a claim. These tests
// lock that property, and the one that matters most is the versionless case: a false
// claim that names no version has to fail here, because the version check returns
// zero on the very same bytes.
// ---------------------------------------------------------------------------

const EM = '—';
const FM_MIN = `---\nstatus: planning\n---\n`;

function stateDoc(fm, body) {
  return `---\n${fm}\n---\n\n# Project State\n\n${body}`;
}

const MINIMAL_POSITION = stateDoc(
  "ferrox_state_version: '1.0'\nmilestone: v1.14\nstatus: executing",
  `## Current Position\n\nPhase: 14.1 (governance-truth) ${EM} EXECUTING\nPlan: 1 of 4\nStatus: Executing Phase 14.1\nLast activity: 2026-07-25 ${EM} Phase 14.1 execution started\n`,
);

// RETARGETED by phase 14.1 plan 02, which performed the D3d surgery. This case
// used to read the LIVE .planning/STATE.md, because at plan-01 time that file
// still carried the free-prose sections. It is now compliant by construction, so
// pinning the rejection to it would assert the surgery had NOT happened. The
// assertion moves to the committed SC4 regression fixture, which reproduces the
// pre-surgery shape and must never be repaired.
test('checkStateStructure rejects the pre-surgery STATE.md shape by heading and line number', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'governance', 'STATE-declaration-ok-body-stale.md');
  const text = fs.readFileSync(fixturePath, 'utf8');
  const errors = lib.checkStateStructure(text, 'STATE.md');
  const lines = text.split(/\r?\n/);

  for (const heading of ['## Project Reference', '## Session Continuity']) {
    const expectedLine = lines.indexOf(heading) + 1;
    assert.ok(expectedLine > 0, `fixture drift: ${heading} is no longer in the SC4 fixture`);
    const hit = errors.find((e) => e.code === 'E_GOV_STATE_SECTION' && e.line === expectedLine);
    assert.ok(hit, `${heading} at line ${expectedLine} must be rejected; it is a free-prose section D3d deletes`);
  }
});

// The complement, added by plan 02: the LIVE file is now green. Together the 2
// cases prove the guard discriminates rather than merely rejecting everything.
test('checkStateStructure accepts the live post-surgery STATE.md', () => {
  const statePath = path.join(__dirname, '..', '.planning', 'STATE.md');
  const errors = lib.checkStateStructure(fs.readFileSync(statePath, 'utf8'), 'STATE.md');
  assert.deepEqual(errors, [], `live STATE.md is non-conforming: ${JSON.stringify(errors, null, 2)}`);
});

test('THE PROPERTY THE APPROACH CHANGE BOUGHT: a versionless false claim FAILS', () => {
  const doc = `${FM_MIN}\n# Project State\n\n## Current Position\n\nPlan: 14-01 planned, awaiting execution\n`;
  const structural = lib.checkStateStructure(doc, 'STATE.md');
  assert.ok(
    structural.some((e) => e.code === 'E_GOV_STATE_PROSE'),
    'this line names no version anywhere, and detectStaleClaims returns ZERO on the same bytes; if this assertion ever passes for the wrong reason the phase has rebuilt its own defect',
  );
  assert.deepEqual(
    lib.detectStaleClaims('Plan: 14-01 planned, awaiting execution', 'STATE.md', ACTIVE),
    [],
    'the contrast is the proof the approach change was real and not a rename',
  );
});

test('checkStateStructure rejects a last-activity line carrying a comma and a narrative', () => {
  const doc = stateDoc(
    'status: executing',
    `## Current Position\n\nLast activity: 2026-07-25 ${EM} Phase 14 complete, and the fleet is looking healthy\n`,
  );
  const errors = lib.checkStateStructure(doc, 'STATE.md');
  assert.ok(errors.some((e) => e.code === 'E_GOV_STATE_PROSE'), 'narrative appended to a machine field is prose wearing a field name');
});

test('checkStateStructure returns zero on a minimal document whose 4 values are SDK writer templates', () => {
  assert.deepEqual(
    lib.checkStateStructure(MINIMAL_POSITION, 'STATE.md'),
    [],
    'a shape too tight stops the line, which is worse than the drift it prevents (T-14.1-04)',
  );
});

test('checkStateStructure accepts the clock-bearing frontmatter keys, retained on purpose', () => {
  const doc = stateDoc(
    `ferrox_state_version: '1.0'\nmilestone: v1.14\nstatus: executing\nlast_updated: "2026-07-25T13:40:29.724Z"\nlast_activity: 2026-07-25`,
    `## Current Position\n\nPhase: 14.1 (governance-truth) ${EM} EXECUTING\nPlan: 1 of 4\nStatus: Executing Phase 14.1\nLast activity: 2026-07-25 ${EM} Phase 14.1 execution started\n`,
  );
  assert.deepEqual(lib.checkStateStructure(doc, 'STATE.md'), [], 'D3d drops byte compare, so a moving timestamp costs nothing and removing the keys would break resume for no gain');
});

test('checkStateStructure accepts the progress counter block and rejects an unknown counter', () => {
  const good = stateDoc(
    'status: planning\nprogress:\n  total_phases: 2\n  completed_phases: 1\n  total_plans: 5\n  completed_plans: 1\n  percent: 20',
    '## Current Position\n\nStatus: Ready to plan\n',
  );
  assert.deepEqual(lib.checkStateStructure(good, 'STATE.md'), []);
  const bad = stateDoc('status: planning\nprogress:\n  velocity_guess: 9', '## Current Position\n\nStatus: Ready to plan\n');
  assert.ok(lib.checkStateStructure(bad, 'STATE.md').some((e) => e.code === 'E_GOV_STATE_FM_KEY'));
});

test('checkStateStructure rejects a frontmatter key outside the allowed set', () => {
  const doc = stateDoc('status: planning\nlast_session: 2026-07-25 planning and cross-audit', '## Current Position\n\nStatus: Ready to plan\n');
  const errors = lib.checkStateStructure(doc, 'STATE.md');
  assert.ok(errors.some((e) => e.code === 'E_GOV_STATE_FM_KEY'), 'the key set is closed; a new narrative key is a new prose surface');
});

test('checkStateStructure bounds the 2 residual narrative frontmatter keys', () => {
  const long = 'x'.repeat(121);
  const doc = stateDoc(`status: planning\nstopped_at: ${long}`, '## Current Position\n\nStatus: Ready to plan\n');
  assert.ok(lib.checkStateStructure(doc, 'STATE.md').some((e) => e.code === 'E_GOV_STATE_FM_PROSE'));
});

test('checkStateStructure flags a versioned stale claim inside a narrative frontmatter key', () => {
  const doc = stateDoc('milestone: v1.14\nstatus: planning\nlast_activity_desc: resume from the v1.1 artifact', '## Current Position\n\nStatus: Ready to plan\n');
  const errors = lib.checkStateStructure(doc, 'STATE.md');
  assert.ok(
    errors.some((e) => e.code === 'E_GOV_STATE_FM_PROSE'),
    'a VERSIONLESS claim in these 2 keys stays uncaught and is filed as backlog, not hidden',
  );
});

test('checkStateStructure rejects any heading of level 3 or deeper, whatever its text', () => {
  const doc = stateDoc('status: planning', '## Current Position\n\nStatus: Ready to plan\n\n### Decisions\n\n- something\n');
  const errors = lib.checkStateStructure(doc, 'STATE.md');
  assert.ok(errors.some((e) => e.code === 'E_GOV_STATE_SUBSECTION'), 'depth is what removes decisions, pending todos, blockers and roadmap evolution without naming them');
});

test('checkStateStructure accepts each allowed level 2 heading and rejects every other one', () => {
  for (const heading of lib.STATE_ALLOWED_SECTIONS) {
    const doc = stateDoc('status: planning', `## ${heading}\n`);
    assert.deepEqual(lib.checkStateStructure(doc, 'STATE.md'), [], `${heading} is in the allowed set and must pass`);
  }
  for (const heading of ['Project Reference', 'Accumulated Context', 'Deferred Items', 'Session Continuity', 'Session Continuity Archive']) {
    const doc = stateDoc('status: planning', `## ${heading}\n`);
    assert.ok(
      lib.checkStateStructure(doc, 'STATE.md').some((e) => e.code === 'E_GOV_STATE_SECTION'),
      `${heading} is deleted by the D3d table and must be rejected`,
    );
  }
});

test('a level 2 audit-log heading is a STRUCTURAL FAILURE, because its entries carry deleted prose verbatim', () => {
  const doc = `${FM_MIN}\n# Project State\n\n## Rebuild Log\n\n- timestamp: 2026-07-25T00:00:00Z\n`;
  assert.ok(
    lib.checkStateStructure(doc, 'STATE.md').some((e) => e.code === 'E_GOV_STATE_SECTION'),
    'the writer at src/state-transition.cts:2015-2054 renders a before field at :2024 holding the drifted prose it just deleted; admitting the heading would let a versionless false claim survive inside the file the log audits',
  );
  assert.equal(
    /rebuild/i.test(lib.STATE_ALLOWED_SECTIONS.join('|')),
    false,
    'the absence from the constant is the load-bearing part; a future reader who adds it back to silence a failure is reopening the defect',
  );
});

test('checkStateStructure accepts a Current Position field written as a pipe-table row', () => {
  const doc = stateDoc(
    'status: executing',
    `## Current Position\n\n| Field | Value |\n|-------|-------|\n| Phase | 14.1 (governance-truth) ${EM} EXECUTING |\n| Plan | 1 of 4 |\n`,
  );
  assert.deepEqual(lib.checkStateStructure(doc, 'STATE.md'), [], 'stateReplaceField falls back to the table form at src/state-document.cts:98-107');
});

test('checkStateStructure rejects a pipe-table row whose value is prose', () => {
  const doc = stateDoc('status: executing', '## Current Position\n\n| Field | Value |\n|-------|-------|\n| Status | waiting on Sean to decide |\n');
  assert.ok(lib.checkStateStructure(doc, 'STATE.md').some((e) => e.code === 'E_GOV_STATE_PROSE'));
});

test('checkStateStructure accepts the Performance Metrics body and rejects a free sentence in it', () => {
  const ok = stateDoc(
    'status: planning',
    '## Performance Metrics\n\n**Velocity:**\n- Total plans completed: 12\n- Average duration: 14 min\n- Total execution time: 3.2 hours\n\n**By Phase:**\n\n| Phase | Plans | Total | Avg/Plan |\n|-------|-------|-------|----------|\n| 14 | 1 | - | - |\n\n**Recent Trend:**\n- Trend: Stable\n\n*Updated after each plan completion*\n',
  );
  assert.deepEqual(lib.checkStateStructure(ok, 'STATE.md'), [], 'a table of durations cannot go stale the way a sentence can, which is why the section is kept');
  const bad = stateDoc('status: planning', '## Performance Metrics\n\n**Velocity:**\nThe fleet is running well this milestone.\n');
  assert.ok(lib.checkStateStructure(bad, 'STATE.md').some((e) => e.code === 'E_GOV_STATE_PROSE'), 'an approved heading over open prose is the same hole one level down');
});

test('Operator Next Steps admits exactly the one form its writer emits', () => {
  const ok = `${FM_MIN}\n# Project State\n\n## Operator Next Steps\n\n- Start the next milestone with /ferrox-new-milestone\n`;
  assert.deepEqual(lib.checkStateStructure(ok, 'STATE.md'), [], 'this is src/state-transition.cts:1356 verbatim');
  const bad = `${FM_MIN}\n# Project State\n\n## Operator Next Steps\n\n- Wait for Sean to decide whether the fleet should proceed\n`;
  assert.ok(
    lib.checkStateStructure(bad, 'STATE.md').some((e) => e.code === 'E_GOV_STATE_PROSE'),
    'that section is written by one function with one template, so a second line form was authored by something other than the writer',
  );
});

test('Operator Next Steps accepts the codex shell-var command form, or the gate stops every codex project', () => {
  const ok = `${FM_MIN}\n# Project State\n\n## Operator Next Steps\n\n- Start the next milestone with $ferrox-new-milestone\n`;
  assert.deepEqual(
    lib.checkStateStructure(ok, 'STATE.md'),
    [],
    'formatFerroxSlash emits $ferrox-<cmd> on codex per src/runtime-slash.cts:67-73; anchoring the shape to the slash example realises T-14.1-04',
  );
});

test('the 4 exported constants are frozen and their contents are asserted BY NAME', () => {
  for (const name of ['STATE_ALLOWED_FM_KEYS', 'STATE_ALLOWED_SECTIONS', 'STATE_POSITION_VALUE_SHAPES', 'STATE_SECTION_BODY_SHAPES']) {
    assert.equal(Object.isFrozen(lib[name]), true, `${name} must be frozen`);
  }
  assert.deepEqual(
    lib.STATE_ALLOWED_SECTIONS,
    ['Current Position', 'Performance Metrics', 'Operator Next Steps'],
    'growing this set to silence a failure must break a committed test',
  );
  assert.equal(lib.STATE_ALLOWED_SECTIONS.length, 3);
  for (const key of ['ferrox_state_version', 'milestone', 'status', 'last_updated', 'last_activity', 'last_activity_desc', 'progress']) {
    assert.ok(lib.STATE_ALLOWED_FM_KEYS.includes(key), `frontmatter key missing: ${key}`);
  }
  for (const field of ['Phase', 'Plan', 'Status', 'Last activity', 'Progress']) {
    assert.ok(field in lib.STATE_POSITION_VALUE_SHAPES, `position value shape missing: ${field}`);
  }
  assert.deepEqual(Object.keys(lib.STATE_SECTION_BODY_SHAPES).sort(), ['Operator Next Steps', 'Performance Metrics']);
});

test('a Phase value admits a real phase name containing a plus, and still rejects junk', () => {
  const shape = lib.STATE_POSITION_VALUE_SHAPES['Phase'];
  // Regression, 2026-07-26: `phase complete` wrote "16 — Security Prerequisite + Primitives"
  // and the shape rejected it, turning lint:ci red on a correct write. The phase name is
  // ordinary prose taken from the roadmap heading; the char class was simply too narrow.
  // A phase name is not the place to forbid a plus sign.
  for (const good of [
    '16 — Security Prerequisite + Primitives',
    '15 (prove-the-premise) — EXECUTING',
    '14.1 — Governance Truth',
    '3 of 8 — COMPLETE',
  ]) {
    assert.ok(shape.test(good), `should be admitted: ${good}`);
  }
  // The widening must not turn the shape into an anything-goes matcher.
  for (const bad of [
    '16 — Bad;Char',
    '16 — trailing<tag>',
    'not a phase at all',
    '16 — ',
  ]) {
    assert.ok(!shape.test(bad), `should be rejected: ${bad}`);
  }
});

test('every constant entry cites the src writer it was derived from', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'governance-manifest.cts'), 'utf8');
  const cited = src.split(/\r?\n/).filter((l) => /src\/state/.test(l)).length;
  assert.ok(cited >= 14, `expected at least 14 writer citations, found ${cited}; an uncited shape was invented rather than derived`);
});

// ---------------------------------------------------------------------------
// SC4 (task 3): the committed regression fixture and its three-sided assertion
//
// The fixture is an INTENTIONALLY INVALID input, following the convention
// documented at tests/team-manifest.test.cjs:34. It is loaded at module top level
// with an explicit fixture-directory constant, matching tests/canon-facts.test.cjs:21-23.
// ---------------------------------------------------------------------------

const GOVERNANCE_FIXTURE_DIR = path.join(__dirname, 'fixtures', 'governance');
const staleBodyFixture = fs.readFileSync(
  path.join(GOVERNANCE_FIXTURE_DIR, 'STATE-declaration-ok-body-stale.md'),
  'utf8',
);

test('the SC4 fixture is a well-formed markdown document with YAML frontmatter', () => {
  assert.ok(staleBodyFixture.startsWith('---\n'), 'the frontmatter block must open on line 1');
  const lines = staleBodyFixture.split(/\r?\n/);
  assert.ok(lines.indexOf('---', 1) > 0, 'the frontmatter block must close');
  assert.ok(lines.includes('# Project State'), 'the fixture imitates the real artifact it is named after');
});

test('SC4 REGRESSION: a correct declaration over a stale body, proven 3 ways on the SAME bytes', () => {
  const lines = staleBodyFixture.split(/\r?\n/);

  // Side one, the control. Declaration equality reports the file healthy. This side must
  // be present, because SC4 claims the old check was INSUFFICIENT, not absent.
  const declaredMatch = /^milestone:\s*v?(.+)$/m.exec(staleBodyFixture);
  assert.ok(declaredMatch, 'the fixture must carry a frontmatter milestone declaration');
  assert.equal(
    declaredMatch[1].trim(),
    ACTIVE,
    'DECLARATION EQUALITY PASSED THIS FILE. The frontmatter is correct, and a check that compares only the declaration against the active milestone reports this file healthy while its body instructs an agent to resume the wrong milestone',
  );

  // Side two. The version check catches the 2 VERSIONED claims, by line number.
  const staleErrors = lib.detectStaleClaims(staleBodyFixture, 'STATE-declaration-ok-body-stale.md', ACTIVE);
  assert.ok(staleErrors.length >= 2, `expected at least 2 stale-body errors, got ${staleErrors.length}`);
  for (const e of staleErrors) assert.equal(e.code, 'E_GOV_STALE_BODY');

  const focusLine = lines.findIndex((l) => /^\*\*Current focus:\*\*/.test(l)) + 1;
  const resumeLine = lines.findIndex((l) => /^Resume file:/.test(l)) + 1;
  assert.ok(focusLine > 0 && resumeLine > 0, 'fixture drift: the 2 versioned specimens are gone');
  assert.ok(staleErrors.some((e) => e.line === focusLine), `the current-focus line at ${focusLine} must be flagged`);
  assert.ok(staleErrors.some((e) => e.line === resumeLine), `the resume-pointer line at ${resumeLine} must be flagged`);

  // Side three. The structural check catches a line the version check left alone.
  const structural = lib.checkStateStructure(staleBodyFixture, 'STATE-declaration-ok-body-stale.md');
  const versionlessLine = lines.findIndex((l) => /^Plan: 14-01 planned, awaiting execution$/.test(l)) + 1;
  assert.ok(versionlessLine > 0, 'fixture drift: the versionless specimen is gone');
  assert.ok(
    structural.some((e) => e.code === 'E_GOV_STATE_PROSE' && e.line === versionlessLine),
    `line ${versionlessLine} reads "Plan: 14-01 planned, awaiting execution". It is FALSE and it names no version, so the version check returns zero on it. Only the structural check can see it, and 3 of the 4 drifts observed on 2026-07-25 had exactly this shape`,
  );
  assert.deepEqual(
    staleErrors.filter((e) => e.line === versionlessLine),
    [],
    'the version check must return nothing on that same line, which is what makes the 2 mechanisms genuinely different',
  );

  assert.ok(
    structural.some((e) => e.code === 'E_GOV_STATE_SECTION'),
    'the fixture also carries the free-prose sections D3d deletes',
  );
});

test('the SC4 fixture history subheading is left alone, pinning the false-positive boundary', () => {
  const lines = staleBodyFixture.split(/\r?\n/);
  const historyLine = lines.findIndex((l) => /^###\s+Decisions \(v1\.1, retained for history\)$/.test(l)) + 1;
  assert.ok(historyLine > 0, 'fixture drift: the retained-for-history specimen is gone');
  const staleErrors = lib.detectStaleClaims(staleBodyFixture, 'F.md', ACTIVE);
  assert.deepEqual(
    staleErrors.filter((e) => e.line === historyLine),
    [],
    'the version check must not achieve its result by flagging every mention of an old milestone',
  );
});

test('the SC4 fixture says inside itself that it must never be repaired', () => {
  assert.match(staleBodyFixture, /DO NOT REPAIR/i, 'a contributor who tidies this file silently deletes the regression');
  assert.match(staleBodyFixture, /2026-07-25/, 'the fixture records the date the defect was live');
  assert.match(staleBodyFixture, /versionless/i, 'the fixture names which of its lines is the versionless specimen');
});
