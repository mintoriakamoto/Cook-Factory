/**
 * Phase — Phase CRUD, query, and lifecycle operations
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/phase.cjs collapsed to
 * a TypeScript source of truth, compiled by tsc to a gitignored .cjs at the
 * same require() path. Behaviour preserved byte-for-behaviour; only types are added.
 *
 * Re-export shim note (issue #4 / ADR-3524):
 *   The phase lifecycle pure-computation helpers live in phase-lifecycle.cjs.
 *   This file imports NEITHER of them. The claim that cmdPhaseComplete uses
 *   the roadmap progress derivation and the percent clamp was already false
 *   when phase 14.1 read it, and the roadmap derivation itself was retired by
 *   D3c: the aggregate counters come from the phase directories, and the
 *   percent clamp keeps its live consumer inside state-transition.cjs.
 *
 *   The async mutation handlers (phaseAdd, phaseInsert, phaseRemove, phaseComplete)
 *   in phase-lifecycle.ts are I/O-bound and remain per-side per ADR-3524 Section 4.
 *   This file provides the CJS (sync) implementations of those handlers.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
import ioMod = require('./io.cjs');
const { output, error, ERROR_REASON } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- config-loader.cjs is an export= CommonJS module
import configLoaderMod = require('./config-loader.cjs');
const { loadConfig } = configLoaderMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtilsMod = require('./core-utils.cjs');
const { toPosixPath, generateSlugInternal, readSubdirectories } = coreUtilsMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
import phaseIdMod = require('./phase-id.cjs');
const {
  escapeRegex,
  normalizePhaseName,
  phaseMarkdownRegexSource,
  comparePhaseNum,
  phaseTokenMatches,
  OPTIONAL_PROJECT_CODE_PREFIX_SOURCE,
  OPTIONAL_PHASE_TAG_SOURCE,
  PHASE_NUMBER_TOKEN_SOURCE,
} = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-locator.cjs is an export= CommonJS module
import phaseLocatorMod = require('./phase-locator.cjs');
const { findPhaseInternal, getArchivedPhaseDirs } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap-parser.cjs is an export= CommonJS module
import roadmapParserMod = require('./roadmap-parser.cjs');
const { stripShippedMilestones, extractCurrentMilestone, getMilestonePhaseFilter, currentMilestoneRawRanges, withPhaseSection } = roadmapParserMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- state.cjs is an export= CommonJS module
import stateMod = require('./state.cjs');
import { platformWriteSync, platformReadSync, platformEnsureDir, retryRenameSync } from './shell-command-projection.cjs';
import { formatFerroxSlash, resolveRuntime } from './runtime-slash.cjs';
import { realClock } from './clock.cjs';
import { transitionCore } from './state-transition.cjs';
import { updateTableCell } from './markdown-table.cjs';
import { deleteSection, tokenizeHeadings } from './markdown-sectionizer.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap-index-scan.cjs is an export= CommonJS module
import roadmapIndexScan = require('./roadmap-index-scan.cjs');
const { rebuildRoadmapRegions, rebuildFailureMessage } = roadmapIndexScan;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- uat-predicate.cjs is an export= CommonJS module
import uatPredicate = require('./uat-predicate.cjs');
const { evaluateUatPassed } = uatPredicate;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verification.cjs is an export= CommonJS module
import verificationMod = require('./verification.cjs');
const { readVerificationStatus } = verificationMod;

const { planningDir, withPlanningLock, listAvailableWorkstreams, getActiveWorkstream } =
  planningWorkspace;
const { extractFrontmatter, extractPlanGateMetadata } = frontmatterMod;
const {
  readModifyWriteStateMd,
  stateExtractField,
  stateReplaceField,
  syncStateFrontmatter,
  withStateLock,
  updatePerformanceMetricsSection,
  // Phase 14.1 D3c: the SHARED phase-directory derivation. Consumed rather than
  // reimplemented so completePhase's counters and the rebuild path's inventory
  // can never disagree.
  deriveProgressFromPhaseDirs,
} = stateMod;

/**
 * Rebuild the 2 GENERATED regions of ROADMAP.md, or fail loud.
 *
 * Phase 14.1 D3a. The phase index under `## Phases` and the progress section
 * under `## Progress` are rendered from the phase directories and the
 * `### Phase N:` detail headings. Every command in this file that mutates a
 * root of that render calls this before writing, so the file and the drift
 * check cannot disagree. The derivation itself lives in `roadmap-index-scan`
 * and is shared with `scripts/gen-roadmap-index.cjs` and
 * `roadmap update-plan-progress`, so there is exactly 1 renderer in the tree.
 *
 * `completionOverrides` carries the completion date this caller is stamping.
 * The clock stays here, in the impure caller; the renderer never reads one.
 *
 * A malformed region is a REFUSAL with a named repair, never an overwrite. A
 * roadmap with no `### Phase N:` heading has no source to render from, and the
 * shared derivation returns it unchanged rather than emptying its index.
 */
function rebuildRegionsOrFail(
  cwd: string,
  roadmapContent: string,
  completionOverrides?: Record<string, string>,
): string {
  const rebuilt = rebuildRoadmapRegions(cwd, roadmapContent, completionOverrides);
  if (!rebuilt.ok) error(rebuildFailureMessage(rebuilt.errors));
  return rebuilt.text;
}

/**
 * Splice a new `### Phase N:` detail section into the HAND-WRITTEN
 * `## Phase Details` section.
 *
 * Phase 14.1 Rule 1 fix, surfaced by the region contract. `phase add` and
 * `phase add-batch` used to append the section before the LAST `\n---`
 * separator, falling back to end of file. A roadmap that carries no `---`
 * separator, which is the shape the shipped template emits and the shape this
 * repository's own roadmap has, therefore got its new detail section appended
 * AFTER the `## Progress` table, in the wrong section entirely. That was merely
 * untidy while nothing read the section boundary; it is a hard failure now that
 * `## Progress` is a generated region with a content contract, and it was a
 * silent structural defect before that.
 *
 * The insertion point is the end of the `## Phase Details` body, which is the
 * line before the next level 1 or level 2 heading. The prior separator and
 * end-of-file behaviour is kept verbatim as the fallback for a roadmap that
 * carries no such heading.
 */
function insertPhaseDetailSection(content: string, section: string): string {
  const headings = tokenizeHeadings(content).filter((h) => h.level <= 2);
  const detailsIdx = headings.findIndex(
    (h) => h.level === 2 && h.text.trim().toLowerCase() === 'phase details',
  );
  if (detailsIdx !== -1) {
    const next = headings[detailsIdx + 1];
    if (next === undefined) return content + section;
    const lines = content.split(/\r?\n/);
    let offset = 0;
    for (let i = 0; i < next.line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
    return content.slice(0, offset) + section.replace(/^\n/, '') + '\n' + content.slice(offset);
  }
  const lastSeparator = content.lastIndexOf('\n---');
  if (lastSeparator > 0) {
    return content.slice(0, lastSeparator) + section + content.slice(lastSeparator);
  }
  return content + section;
}

// #2893 — strict canonical filter: `{padded_phase}-{NN}-PLAN.md` or `PLAN.md`.
const isCanonicalPlanFile = (f: string): boolean => f.endsWith('-PLAN.md') || f === 'PLAN.md';

// Any .md file with PLAN anywhere in the basename — diagnostic net
const PLAN_OUTLINE_RE = /-PLAN-OUTLINE\.md$/i;
const PLAN_PRE_BOUNCE_RE = /-PLAN.*\.pre-bounce\.md$/i;
const looksLikePlanFile = (f: string): boolean =>
  /\.md$/i.test(f) &&
  /PLAN/i.test(f) &&
  !PLAN_OUTLINE_RE.test(f) &&
  !PLAN_PRE_BOUNCE_RE.test(f);

/**
 * Scope an `updateTableCell` call to the `## Traceability` (or
 * `## Traceability Status`) heading's own section — up to the next H1/H2
 * heading — instead of handing it the WHOLE REQUIREMENTS.md content.
 *
 * F1 (#2245 review, BLOCKER): `updateTableCell` binds to the FIRST GFM table
 * found in whatever text it is given. The shipped requirements template
 * (ferrox-core/templates/requirements.md) puts an `## Out of Scope` table
 * (`| Feature | Reason |`, no `Status` column) BEFORE `## Traceability` — so
 * an unscoped whole-file call targets the Out-of-Scope table instead, fails
 * with `{ok:false, reason:'unknown column: Status'}`, and the real
 * Traceability row is never flipped, while the checkbox surface still flips
 * and the command reports success (the #2140 silent-divergence class one
 * level deeper). The `## Progress` writes that used to be scoped the same way
 * are gone: that region is generated now, so nothing in this file writes it.
 *
 * Falls back to running `updateTableCell` against the whole `text` when no
 * `## Traceability` heading exists — matching the previous (unscoped)
 * behaviour for a REQUIREMENTS.md whose traceability table sits under some
 * other heading, or with no heading at all (never worse than before this fix).
 */
function updateTraceabilityCell(
  text: string,
  match: (row: Record<string, string>, index: number) => boolean,
  column: string,
  newValue: string | ((current: string) => string),
): ReturnType<typeof updateTableCell> {
  const headingMatch = text.match(/^##[ \t]+Traceability(?:[ \t]+Status)?\b/im);
  if (!headingMatch || headingMatch.index === undefined) {
    return updateTableCell(text, match, column, newValue);
  }
  const headingOffset = headingMatch.index;
  const before = text.slice(0, headingOffset);
  const fromHeading = text.slice(headingOffset);
  const nextHeadingOffset = fromHeading.search(/\n#{1,2}[ \t]/);
  const scoped = nextHeadingOffset >= 0 ? fromHeading.slice(0, nextHeadingOffset) : fromHeading;
  const after = nextHeadingOffset >= 0 ? fromHeading.slice(nextHeadingOffset) : '';

  const result = updateTableCell(scoped, match, column, newValue);
  if (!result.ok) return result;
  return { ok: true, value: before + result.value + after };
}

function describeNonCanonicalPlans(dirFiles: string[], matchedFiles: string[]): string | null {
  const matched = new Set(matchedFiles);
  const offenders = dirFiles.filter((f) => looksLikePlanFile(f) && !matched.has(f));
  if (offenders.length === 0) return null;
  return (
    `Found ${offenders.length} plan-shaped file(s) in this phase that don't match the canonical ` +
    `naming convention "{padded_phase}-{NN}-PLAN.md" (or bare "PLAN.md") and were skipped: ` +
    offenders.map((f) => `"${f}"`).join(', ') +
    `. Rename to the canonical form (e.g. "01-01-PLAN.md") so the executor can detect them. ` +
    `See agents/ferrox-planner.md write_phase_prompt step for the full contract.`
  );
}

function extractCanonicalPlanId(filename: string): string {
  const base = filename
    .replace(/-PLAN\.md$/i, '')
    .replace(/-SUMMARY\.md$/i, '')
    .replace(/\.md$/i, '');
  const parts = base.split('-').filter(Boolean);
  // #2043: a phase/plan token component is either a zero-padded number (≥2 digits)
  // or a single-digit-plus-letter id ("3A"); a *bare* single digit is a slug word,
  // so "46-6-rs-…" is not paired into a "46-6" id while "3A-01" stays intact.
  const tokenRe = /^(?:\d{2,}[A-Z]?|\d[A-Z])(?:\.\d+)*$/i;
  const phaseIdx = parts.findIndex((p) => tokenRe.test(p));
  if (phaseIdx >= 0 && phaseIdx + 1 < parts.length && tokenRe.test(parts[phaseIdx + 1])) {
    return `${parts[phaseIdx]}-${parts[phaseIdx + 1]}`;
  }
  return base;
}

interface PhaseListOptions {
  type?: string;
  phase?: string;
  includeArchived?: boolean;
}

function cmdPhasesList(cwd: string, options: PhaseListOptions, raw: boolean): void {
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const { type, phase, includeArchived } = options;

  if (!fs.existsSync(phasesDir)) {
    if (type) {
      output({ files: [], count: 0 }, raw, '');
    } else {
      output({ directories: [], count: 0 }, raw, '');
    }
    return;
  }

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    let dirs: string[] = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    if (includeArchived) {
      const archived = getArchivedPhaseDirs(cwd);
      for (const a of archived) {
        dirs.push(`${a.name} [${a.milestone}]`);
      }
    }

    dirs.sort((a, b) => comparePhaseNum(a, b));

    if (phase) {
      const normalized = normalizePhaseName(phase);
      const match = dirs.find((d) => phaseTokenMatches(d, normalized));
      if (!match) {
        output({ files: [], count: 0, phase_dir: null, error: 'Phase not found' }, raw, '');
        return;
      }
      dirs = [match];
    }

    if (type) {
      const files: string[] = [];
      const warnings: string[] = [];
      for (const dir of dirs) {
        const dirPath = path.join(phasesDir, dir);
        const dirFiles = fs.readdirSync(dirPath);

        let filtered: string[];
        if (type === 'plans') {
          filtered = dirFiles.filter(isCanonicalPlanFile);
          const w = describeNonCanonicalPlans(dirFiles, filtered);
          if (w) warnings.push(`${dir}: ${w}`);
        } else if (type === 'summaries') {
          filtered = dirFiles.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
        } else {
          filtered = dirFiles;
        }

        files.push(...filtered.sort());
      }

      const result: Record<string, unknown> = {
        files,
        count: files.length,
        phase_dir: phase ? dirs[0].replace(/^\d+(?:\.\d+)*-?/, '') : null,
      };
      if (warnings.length) result['warning'] = warnings.join(' | ');
      output(result, raw, files.join('\n'));
      return;
    }

    output({ directories: dirs, count: dirs.length }, raw, dirs.join('\n'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error('Failed to list phases: ' + msg);
  }
}

function cmdPhaseNextDecimal(cwd: string, basePhase: string, raw: boolean): void {
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const normalized = normalizePhaseName(basePhase);

  try {
    let baseExists = false;
    const decimalSet = new Set<number>();

    if (fs.existsSync(phasesDir)) {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      baseExists = dirs.some((d) => phaseTokenMatches(d, normalized));

      const dirPattern = new RegExp(`^${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}${escapeRegex(normalized)}\\.(\\d+)`);
      for (const dir of dirs) {
        const match = dir.match(dirPattern);
        if (match) decimalSet.add(parseInt(match[1], 10));
      }
    }

    const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
    if (fs.existsSync(roadmapPath)) {
      try {
        const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
        const phasePattern = new RegExp(
          `#{2,4}\\s*Phase\\s+${phaseMarkdownRegexSource(normalized)}\\.(\\d+)${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`,
          'gi',
        );
        let pm: RegExpExecArray | null;
        while ((pm = phasePattern.exec(roadmapContent)) !== null) {
          decimalSet.add(parseInt(pm[1], 10));
        }
      } catch {
        /* ROADMAP.md read failure is non-fatal */
      }
    }

    const existingDecimals = Array.from(decimalSet)
      .sort((a, b) => a - b)
      .map((n) => `${normalized}.${n}`);

    let nextDecimal: string;
    if (decimalSet.size === 0) {
      nextDecimal = `${normalized}.1`;
    } else {
      nextDecimal = `${normalized}.${Math.max(...decimalSet) + 1}`;
    }

    output(
      {
        found: baseExists,
        base_phase: normalized,
        next: nextDecimal,
        existing: existingDecimals,
      },
      raw,
      nextDecimal,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error('Failed to calculate next decimal phase: ' + msg);
  }
}

function getRoadmapModeForPhase(cwd: string, phaseNum: string): string | null {
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) return null;

  const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  const milestoneContent = extractCurrentMilestone(rawContent, cwd);
  const fullContent = stripShippedMilestones(rawContent);
  const escapedPhase = phaseMarkdownRegexSource(phaseNum);
  const phaseHeader = new RegExp(`#{2,4}\\s*Phase\\s+${escapedPhase}${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`, 'i');

  for (const content of [milestoneContent, fullContent]) {
    const headerMatch = content.match(phaseHeader);
    if (!headerMatch || headerMatch.index === undefined) continue;

    const sectionStart = headerMatch.index;
    const rest = content.slice(sectionStart);
    const nextHeader = rest.slice(headerMatch[0].length).match(/\n#{2,4}\s+Phase\s+\S/i);
    const sectionEnd = nextHeader
      ? sectionStart + headerMatch[0].length + (nextHeader.index as number)
      : content.length;
    const section = content.slice(sectionStart, sectionEnd);
    const modeMatch = section.match(/\*\*Mode(?::\*\*|\*\*:)\s*([^\n]+)/i);
    if (modeMatch) return modeMatch[1].trim().toLowerCase();
  }

  return null;
}

function cmdPhaseMvpMode(cwd: string, args: string[], raw: boolean): void {
  const phaseNum = args[0];
  if (!phaseNum) {
    error('Usage: phase.mvp-mode <phase-number> [--cli-flag]', ERROR_REASON.USAGE);
  }

  const cliFlagPresent = args.includes('--cli-flag');
  const roadmapMode = getRoadmapModeForPhase(cwd, phaseNum);
  const config = loadConfig(cwd);
  const configMvpMode = Boolean(config.mvp_mode);

  let active = false;
  let source = 'none';
  if (cliFlagPresent) {
    active = true;
    source = 'cli_flag';
  } else if (roadmapMode === 'mvp') {
    active = true;
    source = 'roadmap';
  } else if (configMvpMode) {
    active = true;
    source = 'config';
  }

  output(
    {
      active,
      source,
      roadmap_mode: roadmapMode,
      config_mvp_mode: configMvpMode,
      cli_flag_present: cliFlagPresent,
    },
    raw,
  );
}

function cmdFindPhase(cwd: string, phase: string, raw: boolean): void {
  if (!phase) {
    error('phase identifier required');
  }

  const planBase = planningDir(cwd);
  const normalized = normalizePhaseName(phase);
  const notFound = {
    found: false,
    directory: null,
    phase_number: null,
    phase_name: null,
    plans: [],
    summaries: [],
    searched_directories: [] as string[],
  };

  const searchDirs: string[] = [];
  const flatPhasesDir = path.join(planBase, 'phases');
  if (fs.existsSync(flatPhasesDir)) searchDirs.push(flatPhasesDir);
  try {
    const milestonesDir = path.join(planBase, 'milestones');
    const entries = fs
      .readdirSync(milestonesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^v\d+.*-phases$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of entries) {
      searchDirs.push(path.join(milestonesDir, e.name));
    }
  } catch {
    /* no milestones dir */
  }

  notFound.searched_directories = searchDirs.map((searchDir) =>
    toPosixPath(
      path.join(path.relative(cwd, planBase), path.relative(planBase, searchDir)),
    ),
  );

  for (const searchDir of searchDirs) {
    try {
      const entries = fs.readdirSync(searchDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => comparePhaseNum(a, b));

      // #2237: fail loud when multiple directories match the same bare phase
      // number — prevents cross-project file writes when unrelated projects
      // share a .planning/phases/ tree.
      const matches = dirs.filter((d) => phaseTokenMatches(d, normalized));
      if (matches.length === 0) continue;
      if (matches.length > 1) {
        output({
          ...notFound,
          ambiguous_matches: matches,
          warning: `Phase ${normalized} is ambiguous: ${matches.length} directories match (${matches.map(m => `"${m}"`).join(', ')}). Set a distinct project_code in .planning/config.json to scope resolution.`,
        }, raw, '');
        return;
      }
      const match = matches[0];

      const dirMatch =
        match.match(
          new RegExp(`^${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}(${PHASE_NUMBER_TOKEN_SOURCE})-?(.*)`, 'i')
        ) || match.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})-?(.*)`, 'i'));
      const phaseNumber = dirMatch ? dirMatch[1] : normalized;
      const phaseName = dirMatch && dirMatch[2] ? dirMatch[2] : null;

      const phaseDir = path.join(searchDir, match);
      const phaseFiles = fs.readdirSync(phaseDir);
      const plans = phaseFiles.filter(isCanonicalPlanFile).sort();
      const summaries = phaseFiles.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md').sort();
      const planNamingWarning = describeNonCanonicalPlans(phaseFiles, plans);

      const result: Record<string, unknown> = {
        found: true,
        directory: toPosixPath(
          path.join(
            path.relative(cwd, planBase),
            path.relative(planBase, searchDir),
            match,
          ),
        ),
        phase_number: phaseNumber,
        phase_name: phaseName,
        plans,
        summaries,
      };
      if (planNamingWarning) result['warning'] = planNamingWarning;

      output(result, raw, result['directory']);
      return;
    } catch {
      continue;
    }
  }

  output(notFound, raw, '');
}

function extractObjective(content: string): string | null {
  const m = content.match(/<objective>\s*\n?\s*(.+)/);
  return m ? m[1].trim() : null;
}

interface RawPlan {
  id: string;
  declaredWave: number | null;
  dependsOn: string[];
  autonomous: boolean;
  objective: string | null;
  filesModified: string[];
  taskCount: number;
  hasSummary: boolean;
  // UGE-02 optional gate metadata — undefined when the plan doesn't declare it.
  domain: string | undefined;
  deliverableKind: string | undefined;
  gatePresent: boolean | undefined;
  gateScript: string | undefined;
  // Phase 17 optional work-graph node kind — undefined unless the plan declares
  // the one recognized value, so a plan without it keeps the legacy shape.
  nodeKind: string | undefined;
  nodeKindWarning: string | undefined;
}

/**
 * The only recognized `node_kind`. A seam node fixes a contract every dependent
 * needs, so the work graph schedules it strictly ahead of them.
 */
const SEAM_NODE_KIND = 'seam';

// O(V + E). Assigns each in-phase plan its longest-path topological level over the
// in-phase dependsOn DAG (Kahn's algorithm). Returns { level: Map<id,number>, visited: number }.
// visited < rawPlans.length signals a dependency cycle.
function computeDependencyLevels(
  rawPlans: RawPlan[],
  planMap: Map<string, RawPlan>,
  canonicalToId: Map<string, string>,
): { level: Map<string, number>; visited: number } {
  const level = new Map<string, number>();
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const p of rawPlans) {
    if (!inDeg.has(p.id)) inDeg.set(p.id, 0);
    if (!adj.has(p.id)) adj.set(p.id, []);
    for (const dep of p.dependsOn) {
      const depLower = dep.toLowerCase();
      const resolvedDep = planMap.has(depLower)
        ? (planMap.get(depLower) as RawPlan).id
        : canonicalToId.get(depLower);
      if (!resolvedDep) continue;
      if (!adj.has(resolvedDep)) adj.set(resolvedDep, []);
      (adj.get(resolvedDep) as string[]).push(p.id);
      inDeg.set(p.id, (inDeg.get(p.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const p of rawPlans) {
    if ((inDeg.get(p.id) ?? 0) === 0) {
      queue.push(p.id);
      level.set(p.id, 0);
    }
  }

  // Dequeue by head index (queue[head++]), NOT Array.shift(): shift() is O(n) per
  // call in V8. Head-index dequeue is O(1) amortized -> O(V+E) overall. (#307)
  let head = 0;
  let visited = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    visited++;
    const curLevel = level.get(cur) as number;
    for (const dep of adj.get(cur) ?? []) {
      const newLevel = curLevel + 1;
      if (newLevel > (level.get(dep) ?? -1)) {
        level.set(dep, newLevel);
      }
      inDeg.set(dep, (inDeg.get(dep) as number) - 1);
      if (inDeg.get(dep) === 0) {
        queue.push(dep);
      }
    }
  }

  return { level, visited };
}

function cmdPhasePlanIndex(cwd: string, phase: string, raw: boolean): void {
  if (!phase) {
    error('phase required for phase-plan-index');
  }

  const phasesDir = path.join(planningDir(cwd), 'phases');
  const normalized = normalizePhaseName(phase);

  let phaseDir: string | null = null;
  let phaseDirName: string | null = null;
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => comparePhaseNum(a, b));
    const match = dirs.find((d) => phaseTokenMatches(d, normalized));
    if (match) {
      phaseDir = path.join(phasesDir, match);
      phaseDirName = match;
    }
  } catch {
    // phases dir doesn't exist
  }

  if (!phaseDir) {
    output(
      { phase: normalized, error: 'Phase not found', plans: [], waves: {}, incomplete: [], has_checkpoints: false },
      raw,
    );
    return;
  }
  void phaseDirName; // used only to set phaseDir above

  const phaseFiles = fs.readdirSync(phaseDir);
  const planFiles = phaseFiles.filter(isCanonicalPlanFile).sort();
  const summaryFiles = phaseFiles.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
  const planNamingWarning = describeNonCanonicalPlans(phaseFiles, planFiles);

  const completedPlanIds = new Set(
    summaryFiles.flatMap((s) => {
      const exact = s.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
      const canonical = extractCanonicalPlanId(s);
      return canonical === exact ? [exact] : [exact, canonical];
    }),
  );

  // ── Pass 1: parse each plan file ─────────────────────────────────────────

  const rawPlans: RawPlan[] = [];

  for (const planFile of planFiles) {
    const planId = planFile.replace('-PLAN.md', '').replace('PLAN.md', '');
    const planPath = path.join(phaseDir, planFile);
    const content = fs.readFileSync(planPath, 'utf-8');
    const fm = extractFrontmatter(content);

    const xmlTasks = content.match(/<task[\s>]/gi) || [];
    const mdTasks = content.match(/##\s*Task\s*\d+/gi) || [];
    const taskCount = xmlTasks.length || mdTasks.length;

    const parsedWave = parseInt(fm['wave'] as string, 10);
    const declaredWave = Number.isNaN(parsedWave) ? null : parsedWave;

    let dependsOn: string[] = [];
    const fmDeps = fm['depends_on'];
    if (Array.isArray(fmDeps)) {
      dependsOn = fmDeps.map(String);
    } else if (typeof fmDeps === 'string' && fmDeps.trim() !== '') {
      dependsOn = [fmDeps];
    }

    let autonomous = true;
    if (fm['autonomous'] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue comparison
      autonomous = fm['autonomous'] === 'true' || String(fm['autonomous']) === 'true';
    }

    let filesModified: string[] = [];
    const fmFiles = fm['files_modified'] || fm['files-modified'];
    if (fmFiles) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue scalar-to-string
      filesModified = Array.isArray(fmFiles) ? fmFiles.map(String) : [String(fmFiles)];
    }

    const hasSummary =
      completedPlanIds.has(planId) || completedPlanIds.has(extractCanonicalPlanId(planFile));

    // UGE-02: optional gate metadata (lenient — absent/malformed → undefined).
    const gateMeta = extractPlanGateMetadata(fm);

    // Phase 17: the work-graph node kind. Normalized like the neighbouring
    // scalar keys, and accepted ONLY as the literal seam. An unrecognized value
    // is a planning error to surface, not a reason to refuse to index a phase,
    // so it becomes a warning and never a node kind.
    let nodeKind: string | undefined;
    let nodeKindWarning: string | undefined;
    if (fm['node_kind'] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue scalar-to-string
      const declaredKind = String(fm['node_kind']).trim().toLowerCase();
      if (declaredKind === SEAM_NODE_KIND) {
        nodeKind = SEAM_NODE_KIND;
      } else {
        nodeKindWarning =
          `Plan ${planId}: node_kind '${declaredKind}' is not recognized, so no node_kind key is `
          + `emitted. The only recognized value is ${SEAM_NODE_KIND}.`;
      }
    }

    rawPlans.push({
      id: planId,
      declaredWave,
      dependsOn,
      autonomous,
      objective: extractObjective(content) || (fm['objective'] as string | null) || null,
      filesModified,
      taskCount,
      hasSummary,
      domain: gateMeta.domain,
      deliverableKind: gateMeta.deliverable_kind,
      gatePresent: gateMeta.gate_present,
      gateScript: gateMeta.gate_script,
      nodeKind,
      nodeKindWarning,
    });
  }

  // ── Pass 2: topological level assignment via depends_on DAG ──────────────

  const seenLower = new Map<string, string>();
  for (const p of rawPlans) {
    const lower = p.id.toLowerCase();
    const existing = seenLower.get(lower);
    if (existing !== undefined) {
      error(
        `depends_on index collision in phase ${normalized}: plan IDs '${existing}' and '${p.id}' are identical when case-folded. Rename one file to avoid ambiguous dependency resolution.`,
      );
      return;
    }
    seenLower.set(lower, p.id);
  }

  const planMap = new Map(rawPlans.map((p) => [p.id.toLowerCase(), p]));
  const canonicalToId = new Map(
    rawPlans.map((p) => [extractCanonicalPlanId(p.id).toLowerCase(), p.id]),
  );

  const { level, visited } = computeDependencyLevels(rawPlans, planMap, canonicalToId);

  if (visited < rawPlans.length) {
    const cycleNodes = rawPlans.filter((p) => !level.has(p.id)).map((p) => p.id);
    error(
      `depends_on cycle detected in phase ${normalized} — cycle involves: ${cycleNodes.join(', ')}`,
    );
    return;
  }

  // ── Pass 3: determine lowest bucket key and build output ─────────────────

  const anyWaveZero = rawPlans.some((p) => p.declaredWave === 0);
  const levelOffset = anyWaveZero ? 0 : 1;

  const plans: Record<string, unknown>[] = [];
  const waves: Record<string, string[]> = {};
  const incomplete: string[] = [];
  let hasCheckpoints = false;
  const warnings: string[] = [];

  for (const rawPlan of rawPlans) {
    if (!rawPlan.autonomous) {
      hasCheckpoints = true;
    }
    if (!rawPlan.hasSummary) {
      incomplete.push(rawPlan.id);
    }

    const computedWave = (level.get(rawPlan.id) ?? 0) + levelOffset;
    const effectiveWave = computedWave;
    if (rawPlan.declaredWave !== null && rawPlan.declaredWave !== computedWave) {
      warnings.push(
        `Plan ${rawPlan.id}: declared wave: ${rawPlan.declaredWave} but depends_on DAG places it in wave ${computedWave}`,
      );
    }

    const plan: Record<string, unknown> = {
      id: rawPlan.id,
      wave: effectiveWave,
      depends_on: rawPlan.dependsOn.map((dep) => {
        const lower = String(dep).toLowerCase();
        return planMap.has(lower) ? (planMap.get(lower) as RawPlan).id : dep;
      }),
      autonomous: rawPlan.autonomous,
      objective: rawPlan.objective,
      files_modified: rawPlan.filesModified,
      task_count: rawPlan.taskCount,
      has_summary: rawPlan.hasSummary,
    };

    // UGE-02: surface gate metadata only when declared — plans without it keep
    // the exact legacy output shape (no new keys).
    if (rawPlan.domain !== undefined) plan['domain'] = rawPlan.domain;
    if (rawPlan.deliverableKind !== undefined) plan['deliverable_kind'] = rawPlan.deliverableKind;
    if (rawPlan.gatePresent !== undefined) plan['gate_present'] = rawPlan.gatePresent;
    if (rawPlan.gateScript !== undefined) plan['gate_script'] = rawPlan.gateScript;

    // Phase 17: same conditional discipline, 1 more key.
    if (rawPlan.nodeKind !== undefined) plan['node_kind'] = rawPlan.nodeKind;
    if (rawPlan.nodeKindWarning !== undefined) warnings.push(rawPlan.nodeKindWarning);

    plans.push(plan);

    const waveKey = String(effectiveWave);
    if (!waves[waveKey]) {
      waves[waveKey] = [];
    }
    waves[waveKey].push(rawPlan.id);
  }

  const result: Record<string, unknown> = {
    phase: normalized,
    plans,
    waves,
    incomplete,
    has_checkpoints: hasCheckpoints,
  };
  if (planNamingWarning) result['warning'] = planNamingWarning;
  if (warnings.length > 0) result['warnings'] = warnings;

  output(result, raw);
}

function cmdPhaseAdd(cwd: string, description: string, raw: boolean, customId?: string): void {
  if (!description) {
    error('description required for phase add');
  }

  const config = loadConfig(cwd);
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  const slug = generateSlugInternal(description) || '';

  const { newPhaseId, dirName } = withPlanningLock(cwd, () => {
    const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const content = extractCurrentMilestone(rawContent, cwd);

    const projectCode = (config.project_code as string) || '';
    const prefix = projectCode ? `${projectCode}-` : '';

    let _newPhaseId: number | string;
    let _dirName: string;

    if (customId || config.phase_naming === 'custom') {
      _newPhaseId = customId || slug.toUpperCase();
      if (!_newPhaseId) error('--id required when phase_naming is "custom"');
      _dirName = `${prefix}${_newPhaseId}-${slug}`;
    } else {
      // Collect all phase numbers visible in the current-milestone content.
      // Three sources are scanned so that a phase in ANY representation
      // (section header, roadmap bullet, or on-disk directory) is counted:

      // 1) Section headers: ### Phase N: / ## Phase N: / #### Phase N:
      // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
      const headerPattern = /#{2,4}\s*Phase\s+(\d+)[A-Z]?(?:\.\d+)*(?:\s*\([^)\n]{0,200}\))?:/gi;
      // 2) Roadmap bullet entries: - [ ] **Phase N: ...** (all checkbox variants)
      // The lookahead accepts colon, decimal-dot, whitespace, bold-close asterisk,
      // or end-of-line so titleless forms ("- [ ] **Phase 11**", "- [ ] Phase 11")
      // are counted and cannot collide with a freshly-added phase. (#1229)
      const bulletPattern = /^[ \t]*-[ \t]*\[[^\]]{0,200}\][ \t]*\*{0,2}Phase[ \t]+(\d+)(?=[:.\s*]|$)/gim;

      const usedPhaseNums = new Set<number>();
      let m: RegExpExecArray | null;

      while ((m = headerPattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        if (num !== 999) usedPhaseNums.add(num);
      }
      while ((m = bulletPattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        if (num !== 999) usedPhaseNums.add(num);
      }

      // 3) On-disk phase directories (e.g. phases/11-foo/ with no header yet)
      const phasesOnDisk = path.join(planningDir(cwd), 'phases');
      if (fs.existsSync(phasesOnDisk)) {
        const dirNumPattern = /^(?:[A-Z][A-Z0-9]*-)?(\d+)-/;
        for (const entry of fs.readdirSync(phasesOnDisk)) {
          const match = entry.match(dirNumPattern);
          if (!match) continue;
          const num = parseInt(match[1], 10);
          if (num !== 999) usedPhaseNums.add(num);
        }
      }

      // phase.add appends after the highest *used* number. Collecting numbers from
      // section headers, roadmap bullets, AND on-disk dirs above is what prevents the
      // #1229 collision (a bullet-only Phase N is now counted), so max+1 cannot reuse
      // an existing number.
      const maxUsed = usedPhaseNums.size > 0 ? Math.max(...usedPhaseNums) : 0;
      _newPhaseId = maxUsed + 1;
      const paddedNum = String(_newPhaseId).padStart(2, '0');
      _dirName = `${prefix}${paddedNum}-${slug}`;
    }

    const dirPath = path.join(planningDir(cwd), 'phases', _dirName);

    platformEnsureDir(dirPath);
    platformWriteSync(path.join(dirPath, '.gitkeep'), '');

    const dependsOn =
      config.phase_naming === 'custom'
        ? ''
        : `\n**Depends on:** Phase ${typeof _newPhaseId === 'number' ? _newPhaseId - 1 : 'TBD'}`;
    const phaseEntry =
      `\n### Phase ${_newPhaseId}: ${description}\n\n**Goal:** [To be planned]\n**Requirements**: TBD${dependsOn}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatFerroxSlash('plan-phase', resolveRuntime(cwd)) as string} ${_newPhaseId} to break down)\n`;

    const updatedContent = insertPhaseDetailSection(rawContent, phaseEntry);

    // Phase 14.1 D3a: this command creates a phase directory and appends a
    // `### Phase N:` detail section, which INVALIDATES both generated regions.
    // Before the rebuild, a new phase was silently absent from the index and
    // from the progress table until some other command happened to rewrite
    // them. Rebuilding here is the same collision arriving from the direction
    // of a writer that never wrote the region at all.
    platformWriteSync(roadmapPath, rebuildRegionsOrFail(cwd, updatedContent));
    return { newPhaseId: _newPhaseId, dirName: _dirName };
  });

  const result = {
    phase_number: typeof newPhaseId === 'number' ? newPhaseId : String(newPhaseId),
    padded:
      typeof newPhaseId === 'number' ? String(newPhaseId).padStart(2, '0') : String(newPhaseId),
    name: description,
    slug,
    directory: toPosixPath(
      path.join(path.relative(cwd, planningDir(cwd)), 'phases', dirName),
    ),
    naming_mode: config.phase_naming,
  };

  output(result, raw, result.padded);
}

function cmdPhaseAddBatch(cwd: string, descriptions: string[], raw: boolean): void {
  if (!Array.isArray(descriptions) || descriptions.length === 0) {
    error('descriptions array required for phase add-batch');
  }
  const config = loadConfig(cwd);
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }
  const projectCode = (config.project_code as string) || '';
  const prefix = projectCode ? `${projectCode}-` : '';

  const results = withPlanningLock(cwd, () => {
    let rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const content = extractCurrentMilestone(rawContent, cwd);
    let maxPhase = 0;
    if (config.phase_naming !== 'custom') {
      // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
      const phasePattern = /#{2,4}\s*Phase\s+(\d+)[A-Z]?(?:\.\d+)*(?:\s*\([^)\n]{0,200}\))?:/gi;
      let m: RegExpExecArray | null;
      while ((m = phasePattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        if (num === 999) continue;
        if (num > maxPhase) maxPhase = num;
      }
      const phasesOnDisk = path.join(planningDir(cwd), 'phases');
      if (fs.existsSync(phasesOnDisk)) {
        const dirNumPattern = /^(?:[A-Z][A-Z0-9]*-)?(\d+)-/;
        for (const entry of fs.readdirSync(phasesOnDisk)) {
          const match = entry.match(dirNumPattern);
          if (!match) continue;
          const num = parseInt(match[1], 10);
          if (num === 999) continue;
          if (num > maxPhase) maxPhase = num;
        }
      }
    }
    const added: Record<string, unknown>[] = [];
    for (const description of descriptions) {
      const slug = generateSlugInternal(description) || '';
      let newPhaseId: number | string;
      let dirName: string;
      if (config.phase_naming === 'custom') {
        newPhaseId = slug.toUpperCase();
        dirName = `${prefix}${newPhaseId}-${slug}`;
      } else {
        maxPhase += 1;
        newPhaseId = maxPhase;
        dirName = `${prefix}${String(newPhaseId).padStart(2, '0')}-${slug}`;
      }
      const dirPath = path.join(planningDir(cwd), 'phases', dirName);
      platformEnsureDir(dirPath);
      platformWriteSync(path.join(dirPath, '.gitkeep'), '');
      const dependsOn =
        config.phase_naming === 'custom'
          ? ''
          : `\n**Depends on:** Phase ${typeof newPhaseId === 'number' ? newPhaseId - 1 : 'TBD'}`;
      const phaseEntry =
        `\n### Phase ${newPhaseId}: ${description}\n\n**Goal:** [To be planned]\n**Requirements**: TBD${dependsOn}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatFerroxSlash('plan-phase', resolveRuntime(cwd)) as string} ${newPhaseId} to break down)\n`;
      rawContent = insertPhaseDetailSection(rawContent, phaseEntry);
      added.push({
        phase_number: typeof newPhaseId === 'number' ? newPhaseId : String(newPhaseId),
        padded:
          typeof newPhaseId === 'number' ? String(newPhaseId).padStart(2, '0') : String(newPhaseId),
        name: description,
        slug,
        directory: toPosixPath(
          path.join(path.relative(cwd, planningDir(cwd)), 'phases', dirName),
        ),
        naming_mode: config.phase_naming,
      });
    }
    // Phase 14.1 D3a: rebuild ONCE after the loop rather than once per
    // description, because every description has already appended its detail
    // section by the time the render runs.
    platformWriteSync(roadmapPath, rebuildRegionsOrFail(cwd, rawContent));
    return added;
  });
  output({ phases: results, count: results.length }, raw);
}

function cmdPhaseInsert(cwd: string, afterPhase: string, description: string, raw: boolean): void {
  if (!afterPhase || !description) {
    error('after-phase and description required for phase insert');
  }

  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  const slug = generateSlugInternal(description) || '';

  const { decimalPhase, dirName } = withPlanningLock(cwd, () => {
    const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const content = extractCurrentMilestone(rawContent, cwd);

    const normalizedAfter = normalizePhaseName(afterPhase);
    const afterPhaseEscaped = phaseMarkdownRegexSource(normalizedAfter);
    const targetPattern = new RegExp(`#{2,4}\\s*Phase\\s+${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}:`, 'i');
    const headingMatch = targetPattern.test(content);

    // Phase 14.1 D3a: the bullet-style insertion branch is RETIRED. It wrote an
    // index entry directly, and the index is now generated from the `### Phase
    // N:` detail headings, so a hand-inserted bullet would be discarded by the
    // next render. A roadmap whose phase list is bullets alone therefore falls
    // through to the checklist guard below, which already names the exact
    // repair: the phase needs a detail section.
    if (!headingMatch) {
      const checklistPattern = new RegExp(
        `-\\s*\\[[ x]\\]\\s*(?:\\*\\*)?Phase\\s+${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s]`,
        'i',
      );
      if (checklistPattern.test(content)) {
        error(
          `Phase ${afterPhase} exists in roadmap summary but is missing a detail section (### Phase ${afterPhase}: ...).`,
        );
      }
      error(`Phase ${afterPhase} not found in ROADMAP.md`);
    }

    const phasesDir = path.join(planningDir(cwd), 'phases');
    const normalizedBase = normalizePhaseName(afterPhase);
    const decimalSet = new Set<number>();

    // #2245 audit: existsSync-guarded, mirroring cmdPhaseNextDecimal's identical
    // scan above — a missing phasesDir (no decimal sub-phases yet) is the
    // expected, silent case (empty decimalSet). A readdirSync failure once the
    // dir is confirmed to EXIST is a genuine anomaly; swallowing it used to let
    // `phase insert` proceed with an incomplete decimalSet and risk writing a
    // decimal phase number that collides with an existing on-disk directory
    // the scan simply never saw — surfaced loud instead, like the sibling.
    if (fs.existsSync(phasesDir)) {
      // Initialized (not just declared) so TS's definite-assignment check is
      // satisfied without relying on control-flow narrowing through error()'s
      // `never` return, which TS does not propagate through a destructured
      // module-property function reference — error() still halts the process
      // before `dirs` below is ever computed from this placeholder value.
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        error(`Failed to scan phase directories for existing decimal phases: ${msg}`);
      }
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const decimalPattern = new RegExp(
        `^${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}${escapeRegex(normalizedBase)}\\.(\\d+)`,
      );
      for (const dir of dirs) {
        const dm = dir.match(decimalPattern);
        if (dm) decimalSet.add(parseInt(dm[1], 10));
      }
    }

    const rmPhasePattern = new RegExp(
      `#{2,4}\\s*Phase\\s+${phaseMarkdownRegexSource(normalizedBase)}\\.(\\d+)${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`,
      'gi',
    );
    let rmMatch: RegExpExecArray | null;
    while ((rmMatch = rmPhasePattern.exec(rawContent)) !== null) {
      decimalSet.add(parseInt(rmMatch[1], 10));
    }

    const nextDecimal = decimalSet.size === 0 ? 1 : Math.max(...decimalSet) + 1;
    const _decimalPhase = `${normalizedBase}.${nextDecimal}`;
    const insertConfig = loadConfig(cwd);
    const projectCode = (insertConfig.project_code as string) || '';
    const pfx = projectCode ? `${projectCode}-` : '';
    const _dirName = `${pfx}${_decimalPhase}-${slug}`;
    const dirPath = path.join(planningDir(cwd), 'phases', _dirName);

    platformEnsureDir(dirPath);
    platformWriteSync(path.join(dirPath, '.gitkeep'), '');

    // Phase 14.1 D3a: only the heading-style branch survives. It writes a
    // `### Phase N:` detail section, which is hand-written and out of the
    // generated regions; the index entry and the progress row for the new phase
    // are rendered from that heading by the rebuild below.
    const phaseEntry =
      `\n### Phase ${_decimalPhase}: ${description} (INSERTED)\n\n**Goal:** [Urgent work - to be planned]\n**Requirements**: TBD\n**Depends on:** Phase ${afterPhase}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatFerroxSlash('plan-phase', resolveRuntime(cwd)) as string} ${_decimalPhase} to break down)\n`;

    const headerPattern = new RegExp(
      `(#{2,4}\\s*Phase\\s+${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}:[^\\n]*\\n)`,
      'i',
    );
    const headerMatch = rawContent.match(headerPattern);
    if (!headerMatch) {
      error(`Could not find Phase ${afterPhase} header`);
    }

    const headerIdx = rawContent.indexOf(headerMatch![0]);
    const afterHeader = rawContent.slice(headerIdx + headerMatch![0].length);
    const nextPhaseMatch = afterHeader.match(/\n#{2,4}\s+Phase\s+\d[\d.]*/i);

    let insertIdx: number;
    if (nextPhaseMatch) {
      insertIdx = headerIdx + headerMatch![0].length + (nextPhaseMatch.index as number);
    } else {
      insertIdx = rawContent.length;
    }

    let updatedContent =
      rawContent.slice(0, insertIdx) + phaseEntry + rawContent.slice(insertIdx);

    updatedContent = rebuildRegionsOrFail(cwd, updatedContent);

    platformWriteSync(roadmapPath, updatedContent);
    return { decimalPhase: _decimalPhase, dirName: _dirName };
  });

  const result = {
    phase_number: decimalPhase,
    after_phase: afterPhase,
    name: description,
    slug,
    directory: toPosixPath(
      path.join(path.relative(cwd, planningDir(cwd)), 'phases', dirName),
    ),
  };

  output(result, raw, decimalPhase);
}

interface RenameDirInfo {
  dir: string;
  prefix: string;
  oldDecimal: number;
  slug: string;
}

interface RenameIntInfo {
  dir: string;
  oldInt: number;
  letter: string;
  decimal: number | null;
  slug: string;
}

function renameDecimalPhases(
  phasesDir: string,
  baseInt: number,
  removedDecimal: number,
): { renamedDirs: { from: string; to: string }[]; renamedFiles: { from: string; to: string }[] } {
  const renamedDirs: { from: string; to: string }[] = [];
  const renamedFiles: { from: string; to: string }[] = [];
  const decPattern = new RegExp(`^(0*${baseInt})\\.(\\d+)-(.+)$`);
  const dirs = readSubdirectories(phasesDir, true);
  const toRename: RenameDirInfo[] = dirs
    .map((dir) => {
      const m = dir.match(decPattern);
      return m
        ? { dir, prefix: m[1], oldDecimal: parseInt(m[2], 10), slug: m[3] }
        : null;
    })
    .filter((item): item is RenameDirInfo => item !== null && item.oldDecimal > removedDecimal)
    .sort((a, b) => b.oldDecimal - a.oldDecimal);

  for (const item of toRename) {
    const newDecimal = item.oldDecimal - 1;
    const oldPhaseId = `${baseInt}.${item.oldDecimal}`;
    const newPhaseId = `${baseInt}.${newDecimal}`;
    const newDirName = `${item.prefix}.${newDecimal}-${item.slug}`;
    retryRenameSync(path.join(phasesDir, item.dir), path.join(phasesDir, newDirName));
    renamedDirs.push({ from: item.dir, to: newDirName });
    for (const f of fs.readdirSync(path.join(phasesDir, newDirName))) {
      if (f.includes(oldPhaseId)) {
        const newFileName = f.replace(oldPhaseId, newPhaseId);
        retryRenameSync(
          path.join(phasesDir, newDirName, f),
          path.join(phasesDir, newDirName, newFileName),
        );
        renamedFiles.push({ from: f, to: newFileName });
      }
    }
  }
  return { renamedDirs, renamedFiles };
}

function renameIntegerPhases(
  phasesDir: string,
  removedInt: number,
): { renamedDirs: { from: string; to: string }[]; renamedFiles: { from: string; to: string }[] } {
  const renamedDirs: { from: string; to: string }[] = [];
  const renamedFiles: { from: string; to: string }[] = [];
  const dirs = readSubdirectories(phasesDir, true);
  const toRename: RenameIntInfo[] = dirs
    .map((dir) => {
      const m = dir.match(/^(\d+)([A-Z])?(?:\.(\d+))?-(.+)$/i);
      if (!m) return null;
      const dirInt = parseInt(m[1], 10);
      return dirInt > removedInt && dirInt !== 999
        ? {
            dir,
            oldInt: dirInt,
            letter: m[2] ? m[2].toUpperCase() : '',
            decimal: m[3] ? parseInt(m[3], 10) : null,
            slug: m[4],
          }
        : null;
    })
    .filter((item): item is RenameIntInfo => item !== null)
    .sort((a, b) =>
      a.oldInt !== b.oldInt ? b.oldInt - a.oldInt : (b.decimal || 0) - (a.decimal || 0),
    );

  for (const item of toRename) {
    const newInt = item.oldInt - 1;
    const newPadded = String(newInt).padStart(2, '0');
    const oldPadded = String(item.oldInt).padStart(2, '0');
    const letterSuffix = item.letter || '';
    const decimalSuffix = item.decimal !== null ? `.${item.decimal}` : '';
    const oldPrefix = `${oldPadded}${letterSuffix}${decimalSuffix}`;
    const newPrefix = `${newPadded}${letterSuffix}${decimalSuffix}`;
    const newDirName = `${newPrefix}-${item.slug}`;
    retryRenameSync(path.join(phasesDir, item.dir), path.join(phasesDir, newDirName));
    renamedDirs.push({ from: item.dir, to: newDirName });
    for (const f of fs.readdirSync(path.join(phasesDir, newDirName))) {
      if (f.startsWith(oldPrefix)) {
        const newFileName = newPrefix + f.slice(oldPrefix.length);
        retryRenameSync(
          path.join(phasesDir, newDirName, f),
          path.join(phasesDir, newDirName, newFileName),
        );
        renamedFiles.push({ from: f, to: newFileName });
      }
    }
  }
  return { renamedDirs, renamedFiles };
}

function decrementRoadmapPhaseToken(raw: string, removedInt: number): string {
  const match = String(raw).match(/^(\d+)(\.\d+)?$/);
  if (!match) return raw;
  const num = parseInt(match[1], 10);
  if (!Number.isInteger(num) || num <= removedInt || num === 999) return raw;
  return `${num - 1}${match[2] || ''}`;
}

function decrementRoadmapPaddedPhaseNumber(raw: string, removedInt: number): string {
  const num = parseInt(raw, 10);
  if (!Number.isInteger(num) || num <= removedInt || num === 999) return raw;
  return String(num - 1).padStart(raw.length, '0');
}

function updateRoadmapAfterPhaseRemoval(
  roadmapPath: string,
  targetPhase: string,
  isDecimal: boolean,
  removedInt: number,
  cwd: string,
): void {
  withPlanningLock(cwd, () => {
    let content = fs.readFileSync(roadmapPath, 'utf-8');
    const escaped = escapeRegex(targetPhase);

    // SECTION-DELETION (not a section-body edit) — removes the phase's ENTIRE
    // detail section INCLUDING its own heading line. Migrated onto deleteSection
    // (ADR-2143 §4 / markdown-sectionizer T7): it locates the target heading via
    // tokenizeHeadings + this predicate, then splices out the range from that
    // heading's own start through the next heading of the SAME-OR-HIGHER level —
    // whatever that heading's text is. This fixes a data-loss bug in the prior
    // hand-rolled regex, whose lookahead only recognised ANOTHER "Phase N:"
    // heading as a stop boundary: removing the LAST phase in a roadmap left no
    // such heading to stop at, so the lazy `[\s\S]*?` scan ran to EOF and swept
    // away everything after it — including a trailing `## Progress` heading and
    // its tracking table.
    const phaseHeadingRe = new RegExp(
      `^Phase\\s+${escaped}${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`,
      'i',
    );
    content = deleteSection(
      content,
      (h) => h.level >= 2 && h.level <= 4 && phaseHeadingRe.test(h.text),
    );
    // Phase 14.1 D3a: the checkbox-bullet deletion and the Progress-table row
    // deletion that used to live here are GONE. Both edited a GENERATED region,
    // and both are now the render's job: the removed phase loses its detail
    // heading above, so the rebuild at the end of this function drops its index
    // entry and its progress row together. The detail-section deletion, the
    // heading renumber, the plan-file renumber and the 2 depends-on renumbers
    // below are hand-written region work and stay.

    if (!isDecimal) {
      // #1729: fold an optional pre-colon ( ) tag into the suffix capture so it
      // is re-emitted verbatim — a tagged later phase still gets renumbered.
      content = content.replace(
        /(#{2,4}\s*Phase\s+)(\d+(?:\.\d+)?)((?:\s*\([^)\n]{0,200}\))?\s*:)/gi,
        (_match, prefix: string, num: string, suffix: string) =>
          `${prefix}${decrementRoadmapPhaseToken(num, removedInt)}${suffix}`,
      );
      // Phase 14.1 D3a: the index-bullet renumber and the Progress-table
      // ordinal renumber are GONE for the same reason. Both rewrote a generated
      // region, and the rebuild re-derives every number from the renumbered
      // detail headings directly above.
      content = content.replace(
        /(?<![0-9-])(\d{2})-(\d{2})(?=(?:(?:-[A-Za-z][A-Za-z0-9-]*)?-(?:PLAN|SUMMARY)\.md)|(?![0-9-]))/g,
        (_match, phaseNum: string, planNum: string) =>
          `${decrementRoadmapPaddedPhaseNumber(phaseNum, removedInt)}-${planNum}`,
      );
      content = content.replace(
        /(\*\*Depends on\*\*\s*:\s*Phase\s+)(\d+(?:\.\d+)?)\b/gi,
        (_match, prefix: string, num: string) =>
          `${prefix}${decrementRoadmapPhaseToken(num, removedInt)}`,
      );
      content = content.replace(
        /(Depends on:\*\*\s*Phase\s+)(\d+(?:\.\d+)?)\b/gi,
        (_match, prefix: string, num: string) =>
          `${prefix}${decrementRoadmapPhaseToken(num, removedInt)}`,
      );
    }

    platformWriteSync(roadmapPath, rebuildRegionsOrFail(cwd, content));
  });
}

interface PhaseRemoveOptions {
  force?: boolean;
}

function cmdPhaseRemove(
  cwd: string,
  targetPhase: string,
  options: PhaseRemoveOptions,
  raw: boolean,
): void {
  if (!targetPhase) error('phase number required for phase remove');

  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  const phasesDir = path.join(planningDir(cwd), 'phases');

  if (!fs.existsSync(roadmapPath)) error('ROADMAP.md not found');

  const normalized = normalizePhaseName(targetPhase);
  const isDecimal = targetPhase.includes('.');
  const force = options.force || false;

  const subdirs = readSubdirectories(phasesDir, true);
  const targetDir = subdirs.find((d) => phaseTokenMatches(d, normalized)) || null;

  if (targetDir && !force) {
    const files = fs.readdirSync(path.join(phasesDir, targetDir));
    const summaries = files.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
    if (summaries.length > 0) {
      error(
        `Phase ${targetPhase} has ${summaries.length} executed plan(s). Use --force to remove anyway.`,
      );
    }
  }

  if (targetDir) fs.rmSync(path.join(phasesDir, targetDir), { recursive: true, force: true });

  let renamedDirs: { from: string; to: string }[] = [];
  let renamedFiles: { from: string; to: string }[] = [];
  try {
    const renamed = isDecimal
      ? renameDecimalPhases(
          phasesDir,
          parseInt(normalized.split('.')[0], 10),
          parseInt(normalized.split('.')[1], 10),
        )
      : renameIntegerPhases(phasesDir, parseInt(normalized, 10));
    renamedDirs = renamed.renamedDirs;
    renamedFiles = renamed.renamedFiles;
  } catch (e) {
    // #2245 audit (was ERROR-HIDING): renameDecimalPhases/renameIntegerPhases
    // rename subsequent phase directories ON DISK one at a time — a mid-loop
    // failure leaves SOME directories already renumbered and others not, with
    // no way to recover which (the callee's own renamedDirs/renamedFiles never
    // reach this scope when it throws). Silently swallowing this and falling
    // through to updateRoadmapAfterPhaseRemoval below used to rewrite
    // ROADMAP.md's phase numbers assuming the ENTIRE renumbering succeeded,
    // permanently desyncing ROADMAP.md from the actual (partially-renamed)
    // on-disk directory names. Surface loud instead of compounding it.
    const msg = e instanceof Error ? e.message : String(e);
    error(`Failed to renumber phase directories after removing phase ${targetPhase}: ${msg}`);
  }

  updateRoadmapAfterPhaseRemoval(
    roadmapPath,
    targetPhase,
    isDecimal,
    parseInt(normalized, 10),
    cwd,
  );

  const statePath = path.join(planningDir(cwd), 'STATE.md');
  if (fs.existsSync(statePath)) {
    readModifyWriteStateMd(
      statePath,
      (stateContent: string) => {
        const totalRaw = stateExtractField(stateContent, 'Total Phases');
        if (totalRaw) {
          stateContent =
            stateReplaceField(stateContent, 'Total Phases', String(parseInt(totalRaw, 10) - 1)) ||
            stateContent;
        }
        const ofMatch = stateContent.match(/(\bof\s+)(\d+)(\s*(?:\(|phases?))/i);
        if (ofMatch) {
          stateContent = stateContent.replace(
            /(\bof\s+)(\d+)(\s*(?:\(|phases?))/i,
            `$1${parseInt(ofMatch[2], 10) - 1}$3`,
          );
        }
        return stateContent;
      },
      cwd,
    );
  }

  output(
    {
      removed: targetPhase,
      directory_deleted: targetDir,
      renamed_directories: renamedDirs,
      renamed_files: renamedFiles,
      roadmap_updated: true,
      state_updated: fs.existsSync(statePath),
    },
    raw,
  );
}

interface WriteSpec {
  filePath: string;
  before: string;
  after: string;
}

function writePlanningFileSet(writes: WriteSpec[]): void {
  const applied: WriteSpec[] = [];
  try {
    for (const write of writes) {
      if (write.before === write.after) continue;
      platformWriteSync(write.filePath, write.after);
      applied.push(write);
    }
  } catch (err) {
    for (const write of applied.reverse()) {
      try {
        platformWriteSync(write.filePath, write.before);
      } catch (rollbackErr) {
        const errObj = err as Error & { rollbackError?: unknown };
        errObj.rollbackError = rollbackErr;
        const rollbackMsg =
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        errObj.message +=
          `\nWARNING: rollback failed while restoring ${write.filePath} ` +
          `(${rollbackMsg}). Planning files under .planning/ may be left in an ` +
          `inconsistent, partially rolled back state. Inspect ROADMAP.md / REQUIREMENTS.md / ` +
          `STATE.md before re-running phase complete.`;
        break;
      }
    }
    throw err;
  }
}

function phaseDisplayNameFromRoadmap(roadmapContent: string | null, phaseNum: string | null): string | null {
  if (!roadmapContent || !phaseNum) return null;
  const phaseEscaped = phaseMarkdownRegexSource(phaseNum);
  const heading = roadmapContent.match(new RegExp(`^#{2,4}\\s*Phase\\s+${phaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}\\s*:\\s*([^\\n]+)`, 'im'));
  if (!heading) return null;
  const name = heading[1].replace(/\(INSERTED\)/i, '').trim();
  return name || null;
}

function phaseDisplayNameFromSlug(slug: string | null): string | null {
  if (!slug) return null;
  const name = slug.replace(/-/g, ' ').trim();
  return name || null;
}

function cmdPhaseComplete(cwd: string, phaseNum: string, raw: boolean): void {
  if (!phaseNum) {
    error('phase number required for phase complete');
  }

  // #2028: fail safe in workstream mode with no active workstream. With no active
  // workstream and no --ws, planningDir(cwd) resolves to root .planning, so
  // phase.complete would write STATE.md/ROADMAP.md (and mislabel milestone status)
  // into the shared root that other workstreams read. Mirror the #1912 guard that
  // init.progress got (resolution: FERROX_WORKSTREAM env > stored active pointer; an
  // explicit --ws sets FERROX_WORKSTREAM upstream and satisfies the check).
  const availableWorkstreams = listAvailableWorkstreams(cwd);
  const resolvedWorkstream = process.env['FERROX_WORKSTREAM'] || getActiveWorkstream(cwd);
  if (availableWorkstreams.length > 0 && !resolvedWorkstream) {
    error(
      `phase.complete requires a workstream in workstream mode — no active workstream is set, so root STATE.md/ROADMAP.md (likely stale) would be written. ` +
        `Pass --ws <name> or run ${formatFerroxSlash('workstream set', resolveRuntime(cwd)) as string} first. ` +
        `Available workstreams: ${availableWorkstreams.join(', ')}`,
    );
  }

  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  const statePath = path.join(planningDir(cwd), 'STATE.md');
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const today = realClock.localToday();

  const phaseInfoRaw = findPhaseInternal(cwd, phaseNum);
  if (!phaseInfoRaw) {
    error(`Phase ${phaseNum} not found`);
  }
  const phaseInfo = phaseInfoRaw as unknown as Record<string, unknown>;

  const planCount: number = phaseInfo['plans']
    ? (phaseInfo['plans'] as string[]).length
    : 0;
  const summaryCount: number = phaseInfo['summaries']
    ? (phaseInfo['summaries'] as string[]).length
    : 0;
  let requirementsUpdated = false;

  const warnings: string[] = [];
  const phaseFullDir = path.join(cwd, phaseInfo['directory'] as string);

  try {
    const phaseFiles = fs.readdirSync(phaseFullDir);

    for (const file of phaseFiles.filter((f) => f.includes('-UAT') && f.endsWith('.md'))) {
      const content = fs.readFileSync(path.join(phaseFullDir, file), 'utf-8');
      if (/result: pending/.test(content)) warnings.push(`${file}: has pending tests`);
      if (/result: blocked/.test(content)) warnings.push(`${file}: has blocked tests`);
      if (/status: partial/.test(content)) warnings.push(`${file}: testing incomplete (partial)`);
      if (/status: diagnosed/.test(content)) warnings.push(`${file}: has diagnosed gaps`);
    }

    for (const file of phaseFiles.filter(
      (f) => f.includes('-VERIFICATION') && f.endsWith('.md'),
    )) {
      const content = fs.readFileSync(path.join(phaseFullDir, file), 'utf-8');
      // #1159 (Defect A): read ONLY the frontmatter `status` key to avoid false positives
      // from historical metadata in the file body (e.g. `previous_status: gaps_found`).
      // A full-text regex like /status: gaps_found/ matches the substring inside
      // `previous_status: gaps_found`, producing spurious warnings even when the
      // current frontmatter status is `passed`.
      const verFm = extractFrontmatter(content) as Record<string, unknown>;
      // Normalise to lower-case so `status: Passed` (title-case) is not missed.
      const verStatus = typeof verFm['status'] === 'string' ? verFm['status'].trim().toLowerCase() : '';
      if (verStatus === 'human_needed') warnings.push(`${file}: needs human verification`);
      if (verStatus === 'gaps_found') warnings.push(`${file}: has unresolved gaps`);
    }
  } catch {
    /* best-effort (#2245 audit): this is an ADVISORY pre-scan of UAT/
     * VERIFICATION files for `warnings` in the phase-complete output — the
     * actual completion GATE is readVerificationStatus below (a separate
     * mechanism). A readdirSync/readFileSync failure here just means fewer
     * warnings are surfaced this run, not a blocked or corrupted completion. */
  }

  let nextPhaseNum: string | null = null;
  let nextPhaseName: string | null = null;
  let isLastPhase = true;

  const verificationBlocked = withPlanningLock(cwd, () => {
    const verificationStatus = readVerificationStatus(phaseFullDir);
    if (verificationStatus.status !== 'passed') {
      return verificationStatus;
    }

    const runPhaseCompleteTransaction = () => {
      const writes: WriteSpec[] = [];
      let roadmapContent: string | null = null;

      if (fs.existsSync(roadmapPath)) {
        const originalRoadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
        roadmapContent = originalRoadmapContent;

        // ADR-2143 §4: the plan-count write is routed through withPhaseSection
        // (see mutateMilestonePhase below), which hands this pattern ONLY phase
        // N's own detail-section body — so the pattern no longer needs its own
        // `#{2,4}\s*Phase\s+N` anchor + skip-ahead-past-interior-headings
        // lookahead; the section boundary itself confines the match (the
        // #2067/#2200 boundary-crossing class is structurally impossible here
        // rather than regex-enforced).
        const planCountBodyPattern = /(\*\*Plans:\*\*\s*)[^\n]+/i;

        const phaseInfoSummaries = phaseInfo['summaries'] as string[];

        // Phase 14.1 D3a. The phase-list checkbox flip and the 3 progress-table
        // cell writes that used to live here are GONE, not bypassed: both sit
        // inside a region this file no longer owns, and both are rebuilt below
        // from the phase directories by the shared derivation the generator and
        // `roadmap update-plan-progress` also consume. A writer whose output the
        // next render discards is worse than no writer.
        //
        // What remains is phase N's OWN detail section, which D3a keeps
        // hand-written. #2200: it is still applied ONLY within the current
        // milestone's region(s) (primary section plus optional Phase Details
        // section), so a heading in a shipped milestone, a Backlog section, or a
        // backticked prose literal stays untouched. With no versioned active
        // milestone, fall back to whole-content mutation (prior behaviour).
        const mutateMilestonePhase = (slice: string): string => {
          // ADR-2143 §4: the plan-count write and the per-plan checkbox flips
          // are both scoped to phase N's OWN detail section via
          // withPhaseSection — the edit callback below only ever sees that
          // section's body, so neither regex can escape into a sibling
          // phase's section, a shipped milestone, or a Backlog entry.
          return withPhaseSection(slice, phaseNum, (body) => {
            let b = body.replace(planCountBodyPattern, `$1${summaryCount}/${planCount} plans complete`);
            for (const summaryFile of phaseInfoSummaries) {
              const planId = summaryFile.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
              if (!planId) continue;
              const planEscaped = escapeRegex(planId);
              const planCheckboxPattern = new RegExp(
                `(-\\s*\\[) (\\]\\s*(?:\\*\\*)?${planEscaped}(?:\\*\\*)?)`,
                'i',
              );
              b = b.replace(planCheckboxPattern, '$1x$2');
            }
            return b;
          });
        };

        const milestoneRanges = currentMilestoneRawRanges(roadmapContent, cwd);
        if (milestoneRanges) {
          // Splice later windows first so an earlier window's offsets are not
          // shifted by a length-changing mutation in a later window.
          const windows = [milestoneRanges.details, milestoneRanges.primary]
            .filter((w): w is { start: number; end: number } => w !== null)
            .sort((a, b) => b.start - a.start);
          for (const w of windows) {
            roadmapContent =
              roadmapContent.slice(0, w.start)
              + mutateMilestonePhase(roadmapContent.slice(w.start, w.end))
              + roadmapContent.slice(w.end);
          }
        } else {
          roadmapContent = mutateMilestonePhase(roadmapContent);
        }

        // Phase 14.1 D3a: rebuild the 2 generated regions from the phase
        // directories. The completion date for the phase being completed is
        // passed IN, because this caller holds the clock and the pure renderer
        // is hermetic by contract. Both the index entry and the Completed column
        // render from that one value, so they cannot disagree.
        roadmapContent = rebuildRegionsOrFail(cwd, roadmapContent, { [phaseNum]: today });

        writes.push({
          filePath: roadmapPath,
          before: originalRoadmapContent,
          after: roadmapContent,
        });

        const reqPath = path.join(planningDir(cwd), 'REQUIREMENTS.md');
        if (fs.existsSync(reqPath)) {
          const phaseEsc = phaseMarkdownRegexSource(phaseNum);
          const currentMilestoneRoadmap = extractCurrentMilestone(roadmapContent, cwd);
          const phaseSectionMatch = currentMilestoneRoadmap.match(
            new RegExp(
              `(#{2,4}\\s*Phase\\s+${phaseEsc}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s][\\s\\S]*?)(?=#{2,4}\\s*Phase\\s+|$)`,
              'i',
            ),
          );

          const sectionText = phaseSectionMatch ? phaseSectionMatch[1] : '';
          const reqMatch = sectionText.match(
            /\*\*Requirements:?\*\*[^\S\n]*:?[^\S\n]*([^\n]+)/i,
          );

          const originalReqContent = fs.readFileSync(reqPath, 'utf-8');
          let reqContent = originalReqContent;

          if (reqMatch) {
            const reqIds = reqMatch[1]
              .replace(/[\[\]]/g, '')
              .split(/[,\s]+/)
              .map((r) => r.trim())
              .filter(Boolean);

            for (const reqId of reqIds) {
              const reqEscaped = escapeRegex(reqId);
              reqContent = reqContent.replace(
                new RegExp(`(-\\s*\\[)[ ](\\]\\s*\\*\\*${reqEscaped}\\*\\*)`, 'gi'),
                '$1x$2',
              );

              // Traceability row: | <REQ-ID> | Phase N | Pending|In Progress | ->
              // ... Complete | via the markdown-table seam (ADR-2143 §7). Match the
              // row by its FIRST cell's value (the requirement-ID column) regardless
              // of that column's HEADER name — real tables head it `REQ-ID`, others
              // `Requirement` (#2769/#2203); this mirrors the prior regex's first-cell
              // `\|\s*<id>\s*\|` anchor, not a by-name lookup. Object.values(row) is in
              // header order, so [0] is the first column. Case-insensitive.
              const reqRowMatch = (row: Record<string, string>): boolean =>
                (Object.values(row)[0] ?? '').trim().toLowerCase() === reqId.toLowerCase();
              // Ragged-tolerant (#2245 Blocker 2): drive the write purely off
              // updateTableCell's own tolerant row scan — a DIFFERENT
              // requirement's row elsewhere in the same table having a
              // mismatched cell count must never silently no-op THIS
              // requirement's write. The "only flip Pending/In Progress ->
              // Complete" gate is folded into the newValue callback so one
              // updateTableCell call both probes and writes.
              const reqUpdate = updateTraceabilityCell(reqContent, reqRowMatch, 'Status', (current) =>
                /^(?:pending|in progress)$/i.test(current.trim()) ? ' Complete ' : current);
              if (reqUpdate.ok) reqContent = reqUpdate.value;
            }
          }

          // #1159 (Defect B): collect requirement IDs only from ACTIVE sections.
          // Requirements under headings whose text contains "deferred", "backlog",
          // "future", or "v2" (case-insensitive) are explicitly out of current scope
          // and must not be flagged as missing from the Traceability table.
          //
          // Strategy: walk lines, track heading depth, and toggle a "deferred" flag
          // when a heading matching the pattern is encountered.  A sub-heading (higher
          // depth) that is ITSELF in a deferred parent remains deferred unless it
          // opens a same-or-shallower heading that does NOT match the pattern.
          // Lines inside fenced code blocks (``` or ~~~) are treated as content, not
          // headings, to avoid false deferred-section detection from code examples.
          const DEFERRED_HEADING_RE = /\b(?:deferred|backlog|future|v\d+)\b/i;
          const bodyReqIds: string[] = [];
          // deferredDepth: the heading level that opened the current deferred block,
          // or 0 when we are in an active section.
          let deferredDepth = 0;
          let inFence = false;
          for (const line of reqContent.split(/\r?\n/)) {
            // Track fenced code blocks (``` or ~~~).
            if (/^\s*(?:```|~~~)/.test(line)) {
              inFence = !inFence;
              continue;
            }
            if (inFence) continue; // ignore content inside a code fence

            const headingM = line.match(/^(#{1,6})\s+(.*)/);
            if (headingM) {
              const depth = headingM[1].length;
              const text = headingM[2];
              if (deferredDepth > 0 && depth > deferredDepth) {
                // Sub-heading inside a deferred block: stays deferred regardless of name.
                continue;
              }
              // Heading at same level or shallower than current deferred opener,
              // or no active deferred block yet.
              if (DEFERRED_HEADING_RE.test(text)) {
                deferredDepth = depth; // enter a deferred block
              } else {
                deferredDepth = 0; // back in an active section
              }
              continue;
            }

            if (deferredDepth > 0) continue; // skip content in deferred sections

            // Collect bold REQ-ID patterns from active-section lines.
            const reqPat = /\*\*([A-Z][A-Z0-9]*-\d+)\*\*/g;
            let bodyMatch: RegExpExecArray | null;
            while ((bodyMatch = reqPat.exec(line)) !== null) {
              const id = bodyMatch[1];
              if (!bodyReqIds.includes(id)) bodyReqIds.push(id);
            }
          }

          const traceabilityHeadingMatch = reqContent.match(/^#{1,6}\s+Traceability\b/im);
          const traceabilitySection = traceabilityHeadingMatch
            ? reqContent.slice(traceabilityHeadingMatch.index)
            : '';
          const tableReqIds = new Set<string>();
          // #2203: match REQ-IDs in any pipe-delimited cell (not just the first
          // column) so a traceability table that leads with a status column (e.g.
          // | ☐ | REQ-01 | …) is parsed correctly instead of reporting every row
          // as missing.
          const tableRowPat = /\|\s*([A-Z][A-Z0-9]*-\d+)\s*\|/g;
          let tableMatch: RegExpExecArray | null;
          while ((tableMatch = tableRowPat.exec(traceabilitySection)) !== null) {
            tableReqIds.add(tableMatch[1]);
          }

          const unregistered = bodyReqIds.filter((id) => !tableReqIds.has(id));
          if (unregistered.length > 0) {
            warnings.push(
              `REQUIREMENTS.md: ${unregistered.length} REQ-ID(s) found in body but missing from Traceability table: ${unregistered.join(', ')} — add them manually to keep traceability in sync`,
            );
          }

          writes.push({ filePath: reqPath, before: originalReqContent, after: reqContent });
          requirementsUpdated = true;
        }
      }

      try {
        const isDirInMilestone = getMilestonePhaseFilter(cwd);
        const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
        const dirs = entries
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .filter(isDirInMilestone)
          .sort((a, b) => comparePhaseNum(a, b));

        for (const dir of dirs) {
          const dm = dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})-?(.*)`, 'i'));
          if (dm) {
            if (/^999(?:\.|$)/.test(dm[1])) continue;
            if (comparePhaseNum(dm[1], phaseNum) > 0) {
              nextPhaseNum = dm[1];
              nextPhaseName = dm[2] || null;
              isLastPhase = false;
              break;
            }
          }
        }
      } catch {
        /* best-effort (#2245 audit): stage 1 of a deliberate 3-stage
         * cascading fallback for locating the next phase (disk dirs → roadmap
         * headings/checkboxes → lowest-outstanding-checkbox override, #2028
         * below). A disk-scan failure here is indistinguishable from "found
         * nothing on disk" and correctly falls through to stage 2, which
         * derives the same information independently from ROADMAP.md content
         * — not a silent data-loss path. */
      }

      if (isLastPhase && roadmapContent !== null) {
        try {
          const roadmapForPhases = extractCurrentMilestone(roadmapContent, cwd);
          // #1591: match BOTH heading-style phases (`### Phase N:`) AND
          // checkbox-list items, INCLUDING the canonical bold form the roadmap
          // template emits (`- [ ] **Phase N: Name**`). When the active
          // milestone's checklist is `- [ ]` items inside a <details> block
          // (and the next phase has no directory yet, so the disk-based
          // resolver finds nothing), this roadmap-enumeration fallback is the
          // only path that can find the next phase. The prior heading-only
          // pattern missed checkbox items, and a checkbox-only broadening still
          // missed the bold template rows → is_last_phase=true on a mid-milestone
          // phase. Allow optional `**`/`__` emphasis after the marker and stop
          // the name capture at emphasis so bold names slug cleanly; the number
          // capture is unchanged.
          // #1729: `(?:\s*\([^)\n]{0,200}\))?` after the number tolerates a pre-colon
          // ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE) so
          // `### Phase N (Cluster B): X` resolves. Captures are unchanged.
          const phasePattern = new RegExp(
            `(?:#{2,4}|-\\s*\\[[ xX]\\])\\s*(?:\\*\\*|__)?\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n*]+)`,
            'gi'
          );
          let pm: RegExpExecArray | null;
          while ((pm = phasePattern.exec(roadmapForPhases)) !== null) {
            if (comparePhaseNum(pm[1], phaseNum) > 0) {
              nextPhaseNum = pm[1];
              nextPhaseName = pm[2]
                .replace(/\(INSERTED\)/i, '')
                .trim()
                .toLowerCase()
                .replace(/\s+/g, '-');
              isLastPhase = false;
              break;
            }
          }
        } catch {
          /* best-effort (#2245 audit): stage 2 of the next-phase cascade
           * (see stage 1's comment above) — a failure here just leaves
           * isLastPhase as stage 1 left it; stage 3 (#2028) below runs next
           * regardless and provides a further, independent override. */
        }
      }

      // #2028: don't stamp "All phases complete" when a LOWER-numbered phase is
      // still outstanding. The two blocks above only clear isLastPhase when a
      // HIGHER-numbered phase exists, so completing the numerically-highest phase
      // out of order (e.g. Phase 10 before Phase 9) wrongly read as milestone-end.
      // A phase is complete iff its roadmap checkbox is `[x]` (phase.complete sets
      // this on completion — including the one just marked above); any earlier
      // phase in this milestone whose checkbox is still `[ ]` means the milestone
      // is not done, and the LOWEST such phase is the real next actionable item —
      // point next_phase at it so STATE.md advances to the gap rather than parking
      // on the just-completed phase. Roadmaps without phase checkboxes (heading-
      // only) retain the prior behavior — there is nothing to scan. The checkbox
      // pattern mirrors the sibling phasePattern's anchoring (only whitespace/bold
      // between the box and "Phase", a required `:`) so unrelated checklist lines
      // that merely mention "Phase N" don't match.
      if (isLastPhase && roadmapContent !== null) {
        try {
          const milestoneScope = extractCurrentMilestone(roadmapContent, cwd);
          const cbPattern = new RegExp(
            `-\\s*\\[(x| )\\]\\s*(?:\\*\\*|__)?\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n*]+)`,
            'gi'
          );
          let cbm: RegExpExecArray | null;
          let lowestOutstanding: { num: string; name: string } | null = null;
          while ((cbm = cbPattern.exec(milestoneScope)) !== null) {
            const isChecked = cbm[1].toLowerCase() === 'x';
            if (!isChecked && comparePhaseNum(cbm[2], phaseNum) < 0) {
              if (lowestOutstanding === null || comparePhaseNum(cbm[2], lowestOutstanding.num) < 0) {
                lowestOutstanding = {
                  num: cbm[2],
                  name: cbm[3].replace(/\(INSERTED\)/i, '').trim().toLowerCase().replace(/\s+/g, '-'),
                };
              }
            }
          }
          if (lowestOutstanding !== null) {
            isLastPhase = false;
            nextPhaseNum = lowestOutstanding.num;
            nextPhaseName = lowestOutstanding.name;
          }
        } catch {
          /* best-effort (#2245 audit): stage 3 (#2028) of the next-phase
           * cascade — a failure here simply leaves isLastPhase/nextPhaseNum
           * as stages 1-2 already determined them; this stage only ever
           * overrides toward "not last" when it finds a genuinely lower
           * outstanding phase, never the reverse. */
        }
      }

      if (fs.existsSync(statePath)) {
        const originalStateContent = platformReadSync(statePath) || '';
        let stateContent = originalStateContent;

        // ADR-1769 Phase 3: the STATE.md field-update policy (Current Phase
        // shape/name, Status, Current Plan, Last Activity + Description, and
        // the Completed/Total Phases + Progress percent block) now dispatches
        // to the STATE.md Transition Module. The ~90-line inline RMW callback
        // that lived here is the pure `completePhaseCore` in
        // src/state-transition.cts, backed by the field-classification table.
        // `updatePerformanceMetricsSection` + `syncStateFrontmatter` stay in
        // this adapter: they are section-table / disk-scan concerns, not
        // classified fields, and `syncStateFrontmatter` is the post-sync this
        // transaction needs (it does NOT go through readModifyWriteStateMd
        // because STATE.md is committed atomically with ROADMAP/REQUIREMENTS).
        const nextPhaseDisplayName =
          phaseDisplayNameFromRoadmap(roadmapContent, nextPhaseNum) ??
          phaseDisplayNameFromSlug(nextPhaseName);
        const completeResult = transitionCore(
          stateContent,
          {
            kind: 'completePhase',
            phaseNum,
            nextPhaseNum,
            nextPhaseName: nextPhaseDisplayName,
            isLastPhase,
            planCount,
            summaryCount,
          },
          {
            clock: realClock,
            // Phase 14.1 D3c. completePhase derives its aggregate progress
            // counters from the PHASE DIRECTORIES on disk, through the same
            // named derivation the rebuild path consumes, so the 2 cannot drift.
            //
            // The roadmap provider is REMOVED, not merely unused. The progress
            // block was its only consumer, which was verified before the change:
            // it was read at exactly one site inside completePhaseCore. Keeping
            // it would keep the cycle alive, because roadmap scoping reads
            // STATE.md's `milestone:` key while STATE progress would read the
            // roadmap. Disk plus the milestone artifacts are the only roots.
            progressProvider: () => deriveProgressFromPhaseDirs(cwd),
          },
        );
        stateContent = completeResult.content;

        stateContent = updatePerformanceMetricsSection(
          stateContent,
          cwd,
          phaseNum,
          planCount,
          summaryCount,
        );
        stateContent = syncStateFrontmatter(stateContent, cwd);

        writes.push({ filePath: statePath, before: originalStateContent, after: stateContent });
      }

      writePlanningFileSet(writes);
    };

    if (fs.existsSync(statePath)) {
      withStateLock(statePath, runPhaseCompleteTransaction);
    } else {
      runPhaseCompleteTransaction();
    }
    return null;
  });

  if (verificationBlocked) {
    const nextStep = verificationBlocked.next_command
      ? ` Next: ${verificationBlocked.next_command}`
      : '';
    error(
      `Phase ${phaseNum} verification is incomplete: ${verificationBlocked.next_action}${nextStep}`,
      ERROR_REASON.PHASE_VERIFICATION_INCOMPLETE,
    );
  }

  let autoPruned = false;
  try {
    const configPath = path.join(planningDir(cwd), 'config.json');
    if (fs.existsSync(configPath)) {
      const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const workflow = rawConfig['workflow'] as Record<string, unknown> | undefined;
      const autoPruneEnabled = workflow && workflow['auto_prune_state'] === true;
      if (autoPruneEnabled && fs.existsSync(statePath)) {
        // Non-hoisted: load-order matters (stateMod must be fully resolved first).
        const { cmdStatePrune } = stateMod;
        cmdStatePrune(cwd, { keepRecent: '3', dryRun: false, silent: true }, true);
        autoPruned = true;
      }
    }
  } catch {
    /* intentionally empty — auto-prune is best-effort */
  }

  const result = {
    completed_phase: phaseNum,
    phase_name: phaseInfo['phase_name'],
    plans_executed: `${summaryCount}/${planCount}`,
    next_phase: nextPhaseNum,
    next_phase_name: nextPhaseName,
    is_last_phase: isLastPhase,
    date: today,
    roadmap_updated: fs.existsSync(roadmapPath),
    state_updated: fs.existsSync(statePath),
    requirements_updated: requirementsUpdated,
    auto_pruned: autoPruned,
    warnings,
    has_warnings: warnings.length > 0,
  };

  output(result, raw);
}

function cmdPhaseUatPassed(
  cwd: string,
  phaseNum: string | undefined,
  raw: boolean,
  opts: { policy?: { requireVerification?: boolean } } = {},
): void {
  if (!phaseNum) {
    error('phase number required for phase uat-passed');
  }

  const phaseInfoRaw = findPhaseInternal(cwd, phaseNum!);
  if (!phaseInfoRaw) {
    error(`Phase ${phaseNum} not found`);
  }
  const phaseInfo = phaseInfoRaw as unknown as Record<string, unknown>;
  const phaseFullDir = path.join(cwd, phaseInfo['directory'] as string);

  const report = evaluateUatPassed(phaseFullDir, { policy: opts.policy });

  output({ phase: phaseNum, ...report }, raw);
}

// #1437 — phase.list-plans: list plan files for a given phase number.
// Returns the full scan result from scanPhasePlans so callers can read plan
// paths without re-discovering the phase directory themselves.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;

function cmdPhaseListPlans(cwd: string, phaseNum: string | undefined, raw: boolean): void {
  if (!phaseNum) {
    error('phase number required for phase list-plans');
  }

  const phaseInfo = findPhaseInternal(cwd, phaseNum!);
  if (!phaseInfo) {
    output({ phase: phaseNum, plan_count: 0, has_plans: false, plans: [], phase_dir: null }, raw);
    return;
  }

  const phaseDir = path.join(cwd, (phaseInfo as unknown as Record<string, unknown>)['directory'] as string);
  const scan = scanPhasePlans(phaseDir);
  const phaseRel = (phaseInfo as unknown as Record<string, unknown>)['directory'] as string;

  // Build absolute-usable relative paths for each plan file.
  const plans = scan.planFiles.map((f: string) => toPosixPath(path.join(phaseRel, f)));

  output({
    phase: phaseNum,
    phase_dir: phaseRel,
    plan_count: scan.planCount,
    has_plans: scan.planCount > 0,
    plans,
  }, raw);
}

export = {
  cmdPhasesList,
  cmdPhaseNextDecimal,
  cmdFindPhase,
  cmdPhasePlanIndex,
  cmdPhaseAdd,
  cmdPhaseAddBatch,
  cmdPhaseMvpMode,
  cmdPhaseInsert,
  cmdPhaseRemove,
  cmdPhaseComplete,
  cmdPhaseUatPassed,
  cmdPhaseListPlans,
  computeDependencyLevels,
};
