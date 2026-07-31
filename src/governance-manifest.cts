/**
 * governance-manifest: the `.planning/*.md` governance-file contract.
 *
 * PURE parser + checker for the 2 halves of the governance rule (Phase 14.1, v1.14 Fleet
 * Mode). Mirrors the `milestone-manifest.cts` shape: a deterministic parser with a
 * result-union error type, so a governance file can be drift-checked instead of trusted.
 *
 * WHY THIS EXISTS: on 2026-07-25 `.planning/STATE.md` carried `milestone: v1.14` in its
 * frontmatter while line 27 of its body read `Current focus: v1.1 "Reach & Triage"` and
 * line 48 pointed an agent at `.planning/MILESTONE-v1.1-REACH.md`. The declaration was
 * correct and the body actively instructed an agent to resume the wrong milestone. A
 * declaration-equality check passes that file green, which is why declaration equality is
 * not the mechanism here.
 *
 * 3 DIFFERENT MECHANISMS LIVE IN THIS FILE, AND THE DIFFERENCE IS LOAD BEARING:
 *   - `detectStaleClaims` is the PATTERN check over BODY lines. It watches the files that
 *     stay prose-bearing, `PROJECT.md` and `ROADMAP.md`. It fires only when a claim line
 *     also names a dotted milestone version, so it has a stated blind spot, and it skips
 *     heading lines entirely. Read its own header before assuming a file it watches is
 *     protected.
 *   - `detectHeadingClaims` is the PATTERN check over HEADING lines in those same 2 prose
 *     files, and it is version blind on purpose: a section titled `Current Milestone` is
 *     the deleted current-state surface returning, with or without a version in its text.
 *   - `checkStateStructure` is the STRUCTURAL check, and it is the one that protects
 *     `STATE.md`. It admits a closed set of sections, frontmatter keys, and value shapes,
 *     so there is nowhere for a claim of any kind to live. That is what catches a false
 *     claim naming no version at all, which is what 3 of the 4 drifts observed in that
 *     file on 2026-07-25 actually were.
 *
 * HERMETIC BY CONTRACT (this is what makes the check meaningful):
 *   - no `child_process`, no filesystem module, no clock read, no network
 *   - callers pass file contents in; this module never reads the disk
 *   - the only import is the in-repo built `milestone-manifest.cjs`, itself hermetic
 *
 * FAIL LOUD: a malformed or non-compliant file returns `{ok:false, code}` entries and is
 * never silently accepted. A silently accepted file is exactly how a governance file rots
 * while looking healthy.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/governance-manifest.cjs.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import milestoneManifest = require('./milestone-manifest.cjs');

// ----------------------------------------------------------------------------
// Result union (verbatim from milestone-manifest.cts:49-73)
// ----------------------------------------------------------------------------

interface GovError {
  ok: false;
  code: string;
  message: string;
  file: string;
  line?: number;
  text?: string;
  section?: string;
}

interface ScopeDeclaration {
  version: string;
  name: string;
  line: number;
}

/** A `shipped_in` pointer taken from the PROJECT.md requirement ledger. */
interface ShippedInPointer {
  id?: unknown;
  shipped_in?: unknown;
}

/** The subset of a milestone-manifest group this module reads. */
interface MilestoneGroupLike {
  milestone?: unknown;
}

function err(
  file: string,
  code: string,
  message: string,
  extra?: { line?: number; text?: string; section?: string },
): GovError {
  const e: GovError = { ok: false, code, message, file };
  if (extra !== undefined) {
    if (extra.line !== undefined) e.line = extra.line;
    if (extra.text !== undefined) e.text = extra.text;
    if (extra.section !== undefined) e.section = extra.section;
  }
  return e;
}

// ----------------------------------------------------------------------------
// D2 / SC2: the scope declaration, written in VISIBLE HUMAN PROSE
// ----------------------------------------------------------------------------

/**
 * The canonical declaration: one bolded sentence naming Scope, the word milestone, a
 * v-prefixed dotted version, and the milestone name in parentheses, with an optional
 * leading blockquote marker.
 *
 * This exact form was chosen because `.planning/ROADMAP.md` line 3 already carries it
 * verbatim, written by a human before any of this existed. That is the evidence it is
 * prose a human actually writes rather than a machine label retrofitted to look like one.
 * D2 forbids a hidden HTML comment marker: a marker splits machine truth from human truth
 * inside one file, so it can be bumped to appease CI while the prose rots.
 */
const SCOPE_DECLARATION = /^\s*(?:>\s*)?\*\*Scope:\s*milestone\s+v(\d+(?:\.\d+)*)\s*\(([^)\n]{1,80})\)\s*\.?\s*\*\*/i;

/** A line that opens a bolded Scope sentence but does not complete the form. */
const SCOPE_HINT = /^\s*(?:>\s*)?\*\*Scope\b/i;

/** Declarations live near the top of the file; a buried one does not count. */
const SCOPE_SCAN_LINES = 40;

/**
 * Parse the scope declaration out of a governance file.
 *
 * Returns `{version, name, line}` on success, or a `GovError`. When `activeVersion` is
 * supplied and the declaration names a different version, the error is
 * `E_GOV_SCOPE_MISMATCH` and its message names BOTH versions, because "the roadmap is
 * wrong" without saying wrong against what is not actionable.
 */
function parseScopeDeclaration(
  text: unknown,
  filename: unknown,
  activeVersion?: unknown,
): ScopeDeclaration | GovError {
  const file = typeof filename === 'string' && filename !== '' ? filename : '<unknown>';
  if (typeof text !== 'string' || text.trim() === '') {
    return err(file, 'E_GOV_SCOPE_MISSING', 'no scope declaration found: the file is empty');
  }

  const lines = text.split(/\r?\n/).slice(0, SCOPE_SCAN_LINES);
  let hinted = -1;

  for (let i = 0; i < lines.length; i++) {
    const m = SCOPE_DECLARATION.exec(lines[i]);
    if (m !== null) {
      const version = m[1];
      const name = m[2].trim();
      if (typeof activeVersion === 'string' && activeVersion !== '' && activeVersion !== version) {
        return err(
          file,
          'E_GOV_SCOPE_MISMATCH',
          `scope declaration names milestone v${version} but the active milestone is v${activeVersion}`,
          { line: i + 1, text: lines[i] },
        );
      }
      return { version, name, line: i + 1 };
    }
    if (hinted === -1 && SCOPE_HINT.test(lines[i])) hinted = i;
  }

  if (hinted !== -1) {
    return err(
      file,
      'E_GOV_SCOPE_MALFORMED',
      'scope declaration is incomplete. Expected one bolded sentence of the form: '
        + '**Scope: milestone v<version> (<Name>).**',
      { line: hinted + 1, text: lines[hinted] },
    );
  }

  return err(
    file,
    'E_GOV_SCOPE_MISSING',
    `no scope declaration in the first ${SCOPE_SCAN_LINES} lines. Add one bolded sentence: `
      + '**Scope: milestone v<version> (<Name>).**',
  );
}

// ----------------------------------------------------------------------------
// The prose-file half: versioned stale-claim detection
// ----------------------------------------------------------------------------

/**
 * The current-state claim labels a governance file uses. Exported and frozen so the set
 * is inspectable and testable rather than inlined, and so narrowing it to make a file
 * pass is a visible test failure.
 *
 * The 2 labels the live 2026-07-25 defect used were `Current focus:` and `Resume file:`.
 * The rest are their siblings in `ferrox-core/templates/state.md`.
 */
const CURRENT_STATE_CLAIM_PATTERNS = Object.freeze([
  /^\s*(?:[-*]\s*)?(?:\*\*)?current\s+focus\s*:?/i,
  /^\s*(?:[-*]\s*)?(?:\*\*)?current\s+milestone\s*:?/i,
  /^\s*(?:[-*]\s*)?(?:\*\*)?current\s+position\s*:?/i,
  /^\s*(?:[-*]\s*)?(?:\*\*)?current\s+phase\s*:?/i,
  /^\s*(?:[-*]\s*)?(?:\*\*)?resume\s+file\s*:?/i,
  /^\s*(?:[-*]\s*)?(?:\*\*)?phase\s*:/i,
  /^\s*(?:[-*]\s*)?(?:\*\*)?plan\s*:/i,
  /^\s*(?:[-*]\s*)?(?:\*\*)?status\s*:/i,
  /^\s*(?:[-*]\s*)?(?:\*\*)?last\s+activity\s*:?/i,
  /^\s*(?:[-*]\s*)?(?:\*\*)?last\s+session\s*:?/i,
]);

/** A v-prefixed dotted milestone version, the only version form this check reads. */
const MILESTONE_VERSION_REF = /\bv(\d+(?:\.\d+)+)/gi;

/**
 * The version half of the claim check, factored out so `checkStateStructure` can run the
 * SAME check over the 2 residual narrative frontmatter values without duplicating it.
 * Returns the milestone versions a line names that are NOT the active one.
 */
function staleVersionsIn(line: string, activeVersion: string): string[] {
  MILESTONE_VERSION_REF.lastIndex = 0;
  const stale: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = MILESTONE_VERSION_REF.exec(line)) !== null) {
    if (m[1] !== activeVersion && !stale.includes(m[1])) stale.push(m[1]);
  }
  return stale;
}

/**
 * Flag a line that makes a current-state claim AND names a milestone version other than
 * the active one.
 *
 * KNOWN LIMITATION, STATED HERE ON PURPOSE. This function fires only when a dotted
 * version is present on the line. It therefore CANNOT SEE A VERSIONLESS CLAIM. On
 * 2026-07-25 the state file carried 4 stale claims in one day and 3 of them named no
 * version at all: a phase described as awaiting execution when it was already complete
 * and committed, an absorb-pattern claim that had been corrected elsewhere the same day,
 * and a worker count a later decision had superseded. A guard that misses 3 of 4 real
 * cases is not a guard, which is why the file that is protected against versionless drift
 * is protected by `checkStateStructure` and NOT by this function.
 *
 * Do not conclude that a prose-bearing file is safe because this function watches it. It
 * catches the versioned case in `PROJECT.md` and `ROADMAP.md` and nothing more.
 *
 * Heading lines are skipped: a retained-for-history heading naming an old milestone is
 * not a current-state claim, and flagging every mention of an old version would make the
 * check useless.
 */
function detectStaleClaims(text: unknown, filename: unknown, activeVersion: unknown): GovError[] {
  const errors: GovError[] = [];
  const file = typeof filename === 'string' && filename !== '' ? filename : '<unknown>';
  if (typeof text !== 'string' || text === '') return errors;
  if (typeof activeVersion !== 'string' || activeVersion === '') return errors;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    if (!CURRENT_STATE_CLAIM_PATTERNS.some((p) => p.test(line))) continue;

    const stale = staleVersionsIn(line, activeVersion);
    if (stale.length === 0) continue;

    errors.push(
      err(
        file,
        'E_GOV_STALE_BODY',
        `current-state claim names milestone v${stale.join(', v')} but the active milestone is v${activeVersion}`,
        { line: i + 1, text: line },
      ),
    );
  }
  return errors;
}

/**
 * A markdown ATX heading, with the leading `#` run and the optional closing `#` run
 * stripped so only the heading TEXT is captured. Up to 3 leading spaces is the CommonMark
 * allowance, and a line starting with `#` is exactly what `detectStaleClaims` skips.
 */
const ATX_HEADING_TEXT = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/**
 * Flag a current-state claim written as a markdown ATX HEADING in a prose-bearing file.
 *
 * WHY THIS IS A SEPARATE FUNCTION FROM `detectStaleClaims`. That function skips every
 * heading line on purpose, so a retained-for-history heading naming a superseded version is
 * not flagged, and it fires only when a dotted version sits on the line. A heading is a
 * different object. A prose governance file that opens a section titled `Current Milestone`
 * has re-created the current-state surface this phase deleted, and it has done so whether or
 * not a version appears in the heading text. The bare heading `## Current Milestone` carries
 * no version at all, so a version-gated rule cannot see it, which is the gap this closes.
 *
 * PROSE-BEARING FILES ONLY, AND THAT SCOPE IS LOAD BEARING. `.planning/STATE.md` opens a
 * section titled `Current Position`, which `STATE_ALLOWED_SECTIONS` admits by name, and that
 * file is already protected against an unadmitted heading by `checkStateStructure` under
 * `E_GOV_STATE_SECTION`. Running this function over the state file would fail the file on
 * its own admitted heading, so the caller applies it to `PROJECT.md` and `ROADMAP.md` and
 * leaves the structural check to do the state file's half.
 *
 * THE VOCABULARY IS `CURRENT_STATE_CLAIM_PATTERNS` VERBATIM. A second list would drift from
 * the first, and narrowing one of them to make a file pass would then stay invisible in the
 * other. That reuse is also what keeps hand-written phase detail headings legitimate: the
 * `phase` pattern requires a colon directly after the word, so `### Phase 14: The Milestone
 * Index` does not match, while `## Current Phase` does.
 */
function detectHeadingClaims(text: unknown, filename: unknown): GovError[] {
  const errors: GovError[] = [];
  const file = typeof filename === 'string' && filename !== '' ? filename : '<unknown>';
  if (typeof text !== 'string' || text === '') return errors;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = ATX_HEADING_TEXT.exec(line);
    if (heading === null) continue;
    const headingText = heading[1];
    if (headingText === '') continue;
    if (!CURRENT_STATE_CLAIM_PATTERNS.some((p) => p.test(headingText))) continue;

    errors.push(
      err(
        file,
        'E_GOV_HEADING_CLAIM',
        `heading "${headingText}" opens a current-state section, and a prose governance file `
          + 'may not claim current state. Delete the section and read the state from the file '
          + 'that derives it.',
        { line: i + 1, text: line },
      ),
    );
  }
  return errors;
}

// ----------------------------------------------------------------------------
// SC6: shipped_in pointer resolution
// ----------------------------------------------------------------------------

/** The literal a requirement uses when it has not shipped yet. */
const SHIPPED_IN_PENDING = 'pending';

/**
 * Resolve every `shipped_in` pointer against the milestone groups.
 *
 * ONE DIRECTION ONLY. A pointer must resolve to a real milestone version or to the
 * literal `pending`. The reverse direction, that every shipped milestone is claimed by
 * some requirement, is DELIBERATELY not enforced: a legitimate state would go red. That
 * follows the asymmetry precedent documented in the header of `scripts/gen-milestones.cjs`.
 */
function resolveShippedIn(
  pointers: unknown,
  groups: unknown,
  filename?: unknown,
): GovError[] {
  const errors: GovError[] = [];
  const file = typeof filename === 'string' && filename !== '' ? filename : 'PROJECT.md';
  if (!Array.isArray(pointers)) return errors;

  const known = new Set<string>();
  if (Array.isArray(groups)) {
    for (const g of groups as MilestoneGroupLike[]) {
      if (g !== null && typeof g === 'object' && typeof g.milestone === 'string') known.add(g.milestone);
    }
  }

  for (const raw of pointers as ShippedInPointer[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : '<unknown>';
    const value = typeof raw.shipped_in === 'string' ? raw.shipped_in.trim() : '';
    if (value.toLowerCase() === SHIPPED_IN_PENDING) continue;
    if (known.has(value.replace(/^v/i, ''))) continue;
    errors.push(
      err(
        file,
        'E_GOV_SHIPPED_IN_UNRESOLVED',
        `requirement ${id} claims shipped_in ${value === '' ? '<empty>' : value}, which resolves to no milestone. `
          + `Use a version present in MILESTONES.md or the literal ${SHIPPED_IN_PENDING}.`,
      ),
    );
  }
  return errors;
}

// ----------------------------------------------------------------------------
// D1: current resolves to the single lifecycle-active artifact
// ----------------------------------------------------------------------------

/**
 * The active milestone version string, or null.
 *
 * D1 is ALREADY SHIPPED at `src/milestone-manifest.cts:305-309`, whose own comment names
 * Phase 14.1 as its consumer. This is a thin wrapper over it, never a second resolver:
 * resolving by newest version means drafting a future milestone artifact turns `lint:ci`
 * red, which an unattended fleet cannot self-resolve.
 *
 * Returns null for BOTH the zero-active and the multiple-active cases, so the CALLER owns
 * the failure message. That is the contract the existing comment already documents.
 */
function activeVersionOf(groups: unknown): string | null {
  if (!Array.isArray(groups)) return null;
  const active = milestoneManifest.activeMilestone(
    groups as Parameters<typeof milestoneManifest.activeMilestone>[0],
  );
  if (active === null) return null;
  const version = (active as MilestoneGroupLike).milestone;
  return typeof version === 'string' && version !== '' ? version : null;
}

// ----------------------------------------------------------------------------
// D3d: the structural contract for STATE.md
// ----------------------------------------------------------------------------

/**
 * The closed frontmatter key set, taken ENTIRELY from `buildStateFrontmatter` at
 * `src/state.cts:1651-1673`. Every entry cites the writer line it came from, so the set
 * is auditable and plan 02's conformance test can prove it complete.
 *
 * THE 3 CLOCK-BEARING KEYS ARE RETAINED ON PURPOSE. Under the superseded round-1 design
 * they were fatal, because a byte-compared generated file gets a fresh timestamp
 * re-injected by the next SDK write, which is permanent red or permanent churn. D3d drops
 * byte compare, so a moving timestamp costs nothing, and removing the keys would break the
 * resume path for no gain. This is not an oversight.
 *
 * The date-only fields are left alone deliberately: `src/clock.cts:100` documents that
 * they use the host local calendar day and must never name a day ahead of the local date
 * of `last_updated`, and nothing here may break that.
 */
const STATE_ALLOWED_FM_KEYS = Object.freeze([
  'ferrox_state_version', // src/state.cts:1651
  'milestone', // src/state.cts:1653; also regexed by src/roadmap-parser.cts:51-60, so the key shape is load bearing
  'milestone_name', // src/state.cts:1654
  'current_phase', // src/state.cts:1655
  'current_phase_name', // src/state.cts:1656
  'current_plan', // src/state.cts:1657
  'status', // src/state.cts:1658, rooted in normalizeStateStatus
  'stopped_at', // src/state.cts:1659, caller-supplied narrative, bounded below
  'paused_at', // src/state.cts:1660
  'last_updated', // src/state.cts:1661, realClock.nowIso() runs unconditionally on every write
  'last_activity', // src/state.cts:1662
  'last_activity_desc', // src/state.cts:1663, caller-supplied narrative, bounded below
  'progress', // src/state.cts:1665-1671
]);

/** The 5 counters inside the progress map. */
const STATE_ALLOWED_PROGRESS_KEYS = Object.freeze([
  'total_phases', // src/state.cts:1666
  'completed_phases', // src/state.cts:1667
  'total_plans', // src/state.cts:1668
  'completed_plans', // src/state.cts:1669
  'percent', // src/state.cts:1670
]);

/**
 * The 2 frontmatter keys that carry caller-supplied narrative. They are the residual
 * prose surface of this design and this plan does not pretend otherwise: they are capped
 * in length and version-checked, so a VERSIONED stale claim there still fails, but a
 * VERSIONLESS claim in these 2 keys remains uncaught. Plan 03 files that as a backlog row
 * rather than hiding it.
 */
const STATE_NARRATIVE_FM_KEYS = Object.freeze(['stopped_at', 'last_activity_desc']); // src/state.cts:1659, src/state.cts:1663
const STATE_NARRATIVE_FM_MAX = 120;

/**
 * The closed level 2 heading set. It holds exactly 3 entries and every other level 2
 * heading is an error, which is the D3d disposition table applied literally: Project
 * Reference, Accumulated Context, Deferred Items, Session Continuity and its Archive
 * variant are all deleted. Any heading of level 3 or deeper is an error regardless of its
 * text, which removes the decisions, pending todos, blockers and roadmap evolution
 * subheadings without needing to name them.
 *
 * THE REBUILD AUDIT-LOG HEADING IS DELIBERATELY ABSENT AND ITS ABSENCE IS LOAD BEARING.
 * Its writer at `src/state-transition.cts:2015-2054` renders a `before:` field at
 * `src/state-transition.cts:2024` carrying the drifted prose it just deleted, verbatim,
 * with newlines escaped, bounded per entry by `truncateForLog` at
 * `src/state-transition.cts:1671` but append-only and never pruned. Admitting that
 * heading would let a versionless false claim survive inside the file while this check
 * returned green, which is this phase rebuilding its own defect. Plan 02 moves the log to
 * an append-only sidecar and retires that writer. A future reader who adds the entry back
 * to silence a failure is reopening exactly that.
 */
const STATE_ALLOWED_SECTIONS = Object.freeze([
  'Current Position', // src/state-transition.cts:244 STATE_MD_SECTIONS.currentPosition; written by mutateCurrentPositionFirstTime at src/state-transition.cts:566
  'Performance Metrics', // src/state-transition.cts:245; written by src/state.cts:534 cmdStateRecordMetric and src/state.cts:2304 updatePerformanceMetricsSection
  'Operator Next Steps', // written by the milestone-close writer at src/state-transition.cts:1348-1357
]);

/**
 * The value a Current Position field may hold, per field. Every entry was derived by
 * READING the writer, never by imagining what looks reasonable.
 *
 * This is the load-bearing half of the contract in both directions. A value regex that is
 * too loose lets prose back in. A value regex that is too tight makes a legitimate SDK
 * write fail CI, which is worse than the disease because it stops the line (T-14.1-04).
 * Plan 02 task 3 is the safety net for both: it drives every mutating subcommand against
 * a scratch file and asserts this function stays green, so a missing template is caught by
 * a test rather than by a red build on a real repo.
 *
 * The long dash inside these patterns is DATA, not prose: it is the separator the SDK
 * itself composes into a Current Position value at `src/state-transition.cts:577`. The
 * editorial gate for this phase bars that character from any sentence this file authors,
 * and permits it inside a value shape, where it is a byte the writer emits.
 */
const STATE_POSITION_VALUE_SHAPES = Object.freeze({
  // src/state-transition.cts:577 phase label; src/state.cts:3073 COMPLETE; src/state-transition.cts:1142 reset; src/state-transition.cts:1331 milestone close; src/state-transition.cts:898-900 of-total and name forms
  'Phase': /^(?:Not started \(defining requirements\)|Milestone v?\d+(?:\.\d+)* complete|\d+(?:\.\d+)*(?: of \d+)?(?: \([^()]{1,60}\))?(?: — (?:EXECUTING|COMPLETE|[A-Za-z0-9][A-Za-z0-9 ._/+-]{0,60}))?)$/,
  // src/state-transition.cts:903, the `Current Phase` primary of the same write
  'Current Phase': /^(?:Not started \(defining requirements\)|Milestone v?\d+(?:\.\d+)* complete|\d+(?:\.\d+)*(?: of \d+)?(?: \([^()]{1,60}\))?(?: — (?:EXECUTING|COMPLETE|[A-Za-z0-9][A-Za-z0-9 ._/+-]{0,60}))?)$/,
  // src/state-transition.cts:475 and src/state-transition.cts:913 and src/state-transition.cts:1770
  'Current Phase Name': /^[A-Za-z0-9][A-Za-z0-9 ._/+-]{0,60}$/,
  // src/state-transition.cts:586 first time; src/state-transition.cts:789 advance; src/state-transition.cts:931 Not started; src/state-transition.cts:1143 and src/state-transition.cts:1332 the em dash placeholder
  'Plan': /^(?:Not started|—|\d+ of (?:\d+|\?)(?: in current phase)?)$/,
  // src/state-transition.cts:790, the legacy separate-field form
  'Current Plan': /^(?:Not started|—|\d+)$/,
  // src/state-transition.cts:479, src/state-transition.cts:1054, src/state-transition.cts:1592
  'Total Plans in Phase': /^\d+$/,
  // src/state-transition.cts:465 and :595 executing; :767 verification; :792 and :1084 ready; :923 plan or all complete; :1303 milestone; :1144 requirements; :1333 awaiting; src/state.cts:3042 phase complete; the tail is KNOWN_TEMPLATE_DEFAULTS at src/state-document.cts:210-226
  'Status': /^(?:Executing Phase \d+(?:\.\d+)*|Phase \d+(?:\.\d+)* complete|Phase complete — ready for verification|Ready to execute|Ready to plan|All phases complete|v?\d+(?:\.\d+)* milestone complete|Defining requirements|Awaiting next milestone|Planning complete|Executing|In progress|Planning|Verifying|Completed|Done|Active|Paused|unknown)$/,
  // src/state-transition.cts:604 started; :633 resumed; :1085 planning complete; :1145 milestone started; :1334 archived; :941 transitioned; src/state.cts:3094 marked complete; bare date at src/state-transition.cts:768;
  // the migration literal is src/ferrox2-import.cts, the fresh-import writer, added by phase 14.1 plan 02: the importer is a writer like any other, so its
  // fixed narrative literal joins the enumerated set. That adds 1 literal to an existing shape and adds NO new shape.
  'Last activity': /^\d{4}-\d{2}-\d{2}(?: — (?:Phase \d+(?:\.\d+)* (?:execution started|execution resumed \(wave continue\)|planning complete|marked complete|complete(?:, transitioned to Phase \d+(?:\.\d+)*)?)|Milestone v?\d+(?:\.\d+)* (?:started|completed and archived)|Migrated from Ferrox-2))?$/,
  // src/state.cts:714, the update-progress verb composes `[bar] NN%` from a 10 cell bar
  'Progress': /^(?:\[[█░]{0,20}\] )?\d{1,3}%$/,
});

/**
 * The body contract for every admitted section OTHER than Current Position, which is
 * covered by `STATE_POSITION_VALUE_SHAPES` instead. A section admitted by
 * `STATE_ALLOWED_SECTIONS` with no stated body contract is an open prose surface wearing
 * an approved heading, which is the same hole one level down, so both get an entry here.
 */
const STATE_SECTION_BODY_SHAPES = Object.freeze({
  // Kept rather than deleted: the content is a numeric table plus fixed bold labels, it
  // carries no version and no claim, and a table of durations cannot go stale the way a
  // sentence can. Writers: src/state.cts:534 cmdStateRecordMetric (its own per-plan table
  // at src/state.cts:651-658 and the scaffold at src/state.cts:669-677) and
  // src/state.cts:2304 updatePerformanceMetricsSection, the latter called unconditionally
  // from src/phase.cts:2209 inside completePhase. Deleting it would mean retargeting the
  // metric verb, which buys nothing.
  'Performance Metrics': Object.freeze([
    /^\*\*(?:Velocity|By Phase|Recent Trend|Per-Plan Metrics):\*\*$/, // src/state.cts:651 label form; the rest are ferrox-core/templates/state.md:41-52
    /^\|.*\|$/, // table header, delimiter and data rows, per src/state.cts:653-657 and src/state.cts:2314
    /^- Total plans completed: (?:\d+|\[N\])$/, // src/state.cts:2409 and src/state.cts:2431 derive this from the By-Phase Plans column
    /^- Average duration: (?:[\d.]+|\[X\]) min$/, // ferrox-core/templates/state.md:43
    /^- Total execution time: (?:[\d.]+|\[X\.X\]) hours$/, // ferrox-core/templates/state.md:44
    /^- Last 5 plans: (?:\[durations\]|[\d.]+(?: ?min)?(?:, ?[\d.]+(?: ?min)?)*)$/, // ferrox-core/templates/state.md:53
    /^- Trend: (?:Improving|Stable|Degrading|\[Improving \/ Stable \/ Degrading\])$/, // ferrox-core/templates/state.md:54
    /^\*Updated after each plan completion\*$/, // ferrox-core/templates/state.md:56, preserved verbatim by src/state.cts:614-620
  ]),
  // Exactly ONE line form, derived from src/state-transition.cts:1356, the create branch.
  // src/state-transition.cts:1351 is the reset branch and emits the identical form. The
  // command token is constrained to a single unspaced token because
  // `nextMilestoneCommand` comes from src/milestone.cts:530 through formatFerroxSlash,
  // which emits a slash form on claude, cursor and opencode and a shell-var form on codex
  // (src/runtime-slash.cts:67-73). Admit nothing broader: that section is written by one
  // function with one template, so any second line form was authored by something other
  // than the writer, which is the definition of the prose this phase deletes.
  'Operator Next Steps': Object.freeze([
    /^- Start the next milestone with \S+$/, // src/state-transition.cts:1356
  ]),
});

/** A markdown table delimiter row, e.g. `|-------|-------|`. */
const TABLE_DELIMITER_ROW = /^\|[\s:|-]+\|$/;
/** A markdown table row of any shape. */
const TABLE_ROW = /^\|.*\|$/;
/** `**FieldName:** value` */
const FIELD_BOLD = /^\*\*([A-Za-z][A-Za-z ]{0,30}?):\*\*[ \t]*(.*)$/;
/** `FieldName: value` */
const FIELD_PLAIN = /^([A-Za-z][A-Za-z ]{0,30}?):[ \t]*(.*)$/;
/** A markdown heading, any level. */
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;

/** Case-blind, whitespace-collapsed name lookup against a fixed set. */
function canonicalName(name: string, allowed: readonly string[]): string | null {
  const key = name.trim().replace(/\s+/g, ' ').toLowerCase();
  for (const a of allowed) {
    if (a.toLowerCase() === key) return a;
  }
  return null;
}

/** Split a 2 cell table row into `[name, value]`, or null when it is not 2 cells. */
function splitTwoCellRow(line: string): [string, string] | null {
  const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|');
  if (cells.length !== 2) return null;
  return [cells[0].trim().replace(/^\*\*|\*\*$/g, '').trim(), cells[1].trim()];
}

/** Check one `Current Position` field against its committed value shape. */
function positionFieldOk(name: string, value: string): boolean {
  const canonical = canonicalName(name, Object.keys(STATE_POSITION_VALUE_SHAPES));
  if (canonical === null) return false;
  const shape = (STATE_POSITION_VALUE_SHAPES as Record<string, RegExp>)[canonical];
  return shape.test(value);
}

/**
 * A minimal YAML frontmatter key reader. Only top-level keys and the 1 nested block this
 * contract admits are needed, so a full YAML parse would be more surface than the job
 * requires and would add a second failure mode for a malformed file.
 */
function readFrontmatterKeys(
  fmLines: string[],
): { top: Array<{ key: string; value: string; offset: number }>; nested: Array<{ parent: string; key: string; offset: number }> } {
  const top: Array<{ key: string; value: string; offset: number }> = [];
  const nested: Array<{ parent: string; key: string; offset: number }> = [];
  let parent = '';
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const topMatch = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (topMatch !== null) {
      parent = topMatch[1];
      top.push({ key: topMatch[1], value: topMatch[2].trim(), offset: i });
      continue;
    }
    const nestedMatch = /^[ \t]+([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (nestedMatch !== null) nested.push({ parent, key: nestedMatch[1], offset: i });
  }
  return { top, nested };
}

/**
 * Structurally validate `.planning/STATE.md`.
 *
 * THIS, AND NOT `detectStaleClaims`, IS WHAT PROTECTS THE STATE FILE. `STATE.md` is not
 * generated and not byte compared, because `src/state.cts:1661` re-injects a wall clock on
 * every write and 18 state subcommands mutate the file. Instead the file is made
 * structurally incapable of carrying a claim: only a committed set of sections, a committed
 * set of frontmatter keys, and a committed set of value shapes are admitted, so there is
 * nowhere for prose to sit and a versionless false claim has nowhere to live.
 *
 * Pure: the caller supplies the whole file bytes. Returns the same result-union error array
 * as the other functions and never throws.
 */
function checkStateStructure(text: unknown, filename: unknown): GovError[] {
  const errors: GovError[] = [];
  const file = typeof filename === 'string' && filename !== '' ? filename : 'STATE.md';
  if (typeof text !== 'string' || text.trim() === '') return errors;

  const lines = text.split(/\r?\n/);

  // ---- frontmatter ----
  let bodyStart = 0;
  let declaredVersion: string | null = null;
  if (lines[0].trim() === '---') {
    let close = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { close = i; break; }
    }
    if (close === -1) {
      errors.push(err(file, 'E_GOV_STATE_FM_KEY', 'frontmatter block is never closed', { line: 1 }));
    } else {
      const fmLines = lines.slice(1, close);
      bodyStart = close + 1;
      const { top, nested } = readFrontmatterKeys(fmLines);

      for (const entry of top) {
        if (entry.key === 'milestone') declaredVersion = entry.value.replace(/^["']|["']$/g, '').replace(/^v/i, '');
        if (!STATE_ALLOWED_FM_KEYS.includes(entry.key)) {
          errors.push(
            err(file, 'E_GOV_STATE_FM_KEY', `frontmatter key "${entry.key}" is outside the closed set written by buildStateFrontmatter`, {
              line: entry.offset + 2,
              text: fmLines[entry.offset],
            }),
          );
        }
      }
      for (const entry of nested) {
        if (entry.parent !== 'progress') continue;
        if (!STATE_ALLOWED_PROGRESS_KEYS.includes(entry.key)) {
          errors.push(
            err(file, 'E_GOV_STATE_FM_KEY', `progress counter "${entry.key}" is outside the closed set`, {
              line: entry.offset + 2,
              text: fmLines[entry.offset],
            }),
          );
        }
      }
      for (const entry of top) {
        if (!STATE_NARRATIVE_FM_KEYS.includes(entry.key)) continue;
        const value = entry.value.replace(/^["']|["']$/g, '');
        if (value.length > STATE_NARRATIVE_FM_MAX) {
          errors.push(
            err(file, 'E_GOV_STATE_FM_PROSE', `frontmatter key "${entry.key}" holds ${value.length} characters, over the ${STATE_NARRATIVE_FM_MAX} character cap`, {
              line: entry.offset + 2,
            }),
          );
        }
        if (declaredVersion !== null) {
          const stale = staleVersionsIn(value, declaredVersion);
          if (stale.length > 0) {
            errors.push(
              err(file, 'E_GOV_STATE_FM_PROSE', `frontmatter key "${entry.key}" names milestone v${stale.join(', v')} but the file declares v${declaredVersion}`, {
                line: entry.offset + 2,
                text: value,
              }),
            );
          }
        }
      }
    }
  }

  // ---- body ----
  const FORBIDDEN = ' forbidden';
  let section: string | null = null;

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const lineNo = i + 1;

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      if (level === 1) { section = null; continue; }
      if (level >= 3) {
        errors.push(
          err(file, 'E_GOV_STATE_SUBSECTION', `heading of level ${level} is not admitted anywhere in the state file`, { line: lineNo, text: line }),
        );
        section = FORBIDDEN;
        continue;
      }
      const canonical = canonicalName(heading[2], STATE_ALLOWED_SECTIONS);
      if (canonical === null) {
        errors.push(
          err(file, 'E_GOV_STATE_SECTION', `section "${heading[2]}" is outside the closed set: ${STATE_ALLOWED_SECTIONS.join(', ')}`, { line: lineNo, text: line }),
        );
        section = FORBIDDEN;
        continue;
      }
      section = canonical;
      continue;
    }

    if (line.trim() === '') continue;
    if (section === FORBIDDEN) continue;

    if (section === null) {
      errors.push(err(file, 'E_GOV_STATE_PROSE', 'line sits outside every admitted section', { line: lineNo, text: line, section: '<preamble>' }));
      continue;
    }

    if (section === 'Current Position') {
      if (TABLE_DELIMITER_ROW.test(line)) continue;
      if (TABLE_ROW.test(line)) {
        // A pipe row immediately followed by a delimiter row is the table header.
        const next = lines[i + 1] === undefined ? '' : lines[i + 1].replace(/\r$/, '');
        if (TABLE_DELIMITER_ROW.test(next)) continue;
        const cells = splitTwoCellRow(line);
        if (cells !== null && positionFieldOk(cells[0], cells[1])) continue;
        errors.push(err(file, 'E_GOV_STATE_PROSE', 'table row is not an admitted Current Position field and value', { line: lineNo, text: line, section }));
        continue;
      }
      const bold = FIELD_BOLD.exec(line);
      if (bold !== null && positionFieldOk(bold[1], bold[2].trim())) continue;
      const plain = FIELD_PLAIN.exec(line);
      if (plain !== null && positionFieldOk(plain[1], plain[2].trim())) continue;
      errors.push(err(file, 'E_GOV_STATE_PROSE', 'line is not an admitted Current Position field and value', { line: lineNo, text: line, section }));
      continue;
    }

    const shapes = (STATE_SECTION_BODY_SHAPES as Record<string, readonly RegExp[]>)[section];
    if (shapes !== undefined && shapes.some((s) => s.test(line))) continue;
    errors.push(err(file, 'E_GOV_STATE_PROSE', `line is not an admitted ${section} body form`, { line: lineNo, text: line, section }));
  }

  return errors;
}

export = {
  parseScopeDeclaration,
  detectStaleClaims,
  detectHeadingClaims,
  checkStateStructure,
  resolveShippedIn,
  activeVersionOf,
  CURRENT_STATE_CLAIM_PATTERNS,
  STATE_ALLOWED_FM_KEYS,
  STATE_ALLOWED_SECTIONS,
  STATE_POSITION_VALUE_SHAPES,
  STATE_SECTION_BODY_SHAPES,
};
