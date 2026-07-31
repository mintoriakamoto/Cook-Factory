"use strict";
/**
 * roadmap-index-scan: the impure shell for the generated ROADMAP regions.
 *
 * One derivation, 3 consumers. The generator script, `src/phase.cts` and
 * `src/roadmap.cts` all rebuild the 2 generated regions through this module, so
 * a command and the drift check cannot disagree about what the file should say.
 * Before this existed, 6 write sites edited those regions directly and the only
 * thing keeping them consistent was that they were written on the same day.
 *
 * IMPURE SHELL, PURE CORE. This module does every disk read. It reads the phase
 * directories, reads the milestone artifacts, and hands `roadmap-index.cjs`
 * plain records and plain text. The pure lib stays hermetic, which is what makes
 * the byte compare in `--check` meaningful.
 *
 * IT CONSUMES THE SHIPPED DERIVATIONS, it does not reimplement them:
 *   - `countMatchedSummaries`, through `plan-scan.cjs`, which is the #1988 fix
 *     that stops a stray non-plan summary from inflating the count
 *   - `determinePhaseStatus` from `commands.cjs`, which is the same function
 *     the init projection already uses to report a phase status
 * The pending default passed to that function is `Not started` with a lowercase
 * s, because that is the value the committed progress table already carries.
 * `src/commands.cts` passes `Not Started` with a capital S at its own call site;
 * the difference is deliberate and keeps the first write from producing a
 * cosmetic diff.
 *
 * NO CYCLE. Nothing here reads the state file, and nothing here calls the
 * current-milestone extractor in `roadmap-parser`, which is the function that
 * reads it. D3c locks the roots: the phase directories plus the milestone
 * artifacts. The roadmap derives from those. The state file derives from those.
 * Neither derives from the other. `commands.cjs` imports neither `phase.cjs`
 * nor `roadmap.cjs`, so the 2 SDK modules that consume this one introduce no
 * import cycle.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/roadmap-index-scan.cjs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// eslint-disable-next-line @typescript-eslint/no-require-imports -- commands.cjs is an export= CommonJS module
const commandsMod = require("./commands.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
const scanPhasePlans = require("./plan-scan.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap-index.cjs is an export= CommonJS module
const roadmapIndex = require("./roadmap-index.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- milestone-manifest.cjs is an export= CommonJS module
const milestoneManifest = require("./milestone-manifest.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
const planningWorkspace = require("./planning-workspace.cjs");
const { determinePhaseStatus } = commandsMod;
const { planningDir } = planningWorkspace;
/** The pending value the committed progress table already carries. */
const PENDING_STATUS = 'Not started';
/** `<optional project code>-<number>-<slug>`, decimal phase numbers included. */
const PHASE_DIR_SHAPE = /^(?:[A-Za-z][A-Za-z0-9_]*-)?(\d+(?:\.\d+)*)-(.+)$/;
/** Compare a heading's phase number with a directory's, ignoring zero padding. */
function normalizeNumber(value) {
    return value
        .split('.')
        .map((seg) => seg.replace(/^0+(?=\d)/, ''))
        .join('.');
}
/** Phase number to absolute directory path, for the directories on disk. */
function phaseDirectories(cwd) {
    const out = new Map();
    let phasesDir;
    try {
        phasesDir = node_path_1.default.join(planningDir(cwd), 'phases');
    }
    catch {
        return out;
    }
    let entries;
    try {
        if (!node_fs_1.default.existsSync(phasesDir))
            return out;
        entries = node_fs_1.default.readdirSync(phasesDir);
    }
    catch {
        return out;
    }
    for (const name of entries) {
        const full = node_path_1.default.join(phasesDir, name);
        try {
            if (!node_fs_1.default.statSync(full).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        const m = PHASE_DIR_SHAPE.exec(name);
        if (m === null)
            continue;
        const key = normalizeNumber(m[1]);
        if (!out.has(key))
            out.set(key, full);
    }
    return out;
}
/**
 * One record per phase NAMED BY A PHASE DETAIL HEADING.
 *
 * A heading with no directory is a planned phase: zero plans, zero summaries,
 * the pending status. A directory with no heading is out of the current
 * milestone and never enters the render, which is what keeps the phase
 * directories of shipped milestones out of the index.
 */
function scanPhaseEntries(cwd, roadmapText, file) {
    const name = typeof file === 'string' && file !== '' ? file : 'ROADMAP.md';
    const collected = roadmapIndex.collectPhaseEntries(roadmapText, name);
    const dirs = phaseDirectories(cwd);
    const entries = [];
    for (const skeleton of collected.entries) {
        const dir = dirs.get(normalizeNumber(skeleton.number));
        if (dir === undefined) {
            entries.push(Object.assign({}, skeleton, {
                planCount: 0,
                summaryCount: 0,
                status: PENDING_STATUS,
            }));
            continue;
        }
        const counts = scanPhasePlans(dir);
        entries.push(Object.assign({}, skeleton, {
            planCount: counts.planCount,
            summaryCount: counts.summaryCount,
            status: determinePhaseStatus(counts.planCount, counts.summaryCount, dir, PENDING_STATUS),
        }));
    }
    return { ok: collected.ok, entries, errors: collected.errors };
}
/** The milestone artifacts, parsed. The scope assertion's only input. */
function readMilestoneGroups(cwd) {
    const dir = planningDir(cwd);
    let names = [];
    try {
        names = node_fs_1.default
            .readdirSync(dir)
            .filter((f) => /^(MILESTONE|BENCHMARK)-v\d/.test(f) && f.endsWith('.md'))
            .sort();
    }
    catch {
        return { groups: [], errors: [] };
    }
    const candidates = names.map((n) => ({ name: n, text: node_fs_1.default.readFileSync(node_path_1.default.join(dir, n), 'utf8') }));
    const selected = milestoneManifest.selectArtifactFiles(candidates);
    const parsed = selected.map((f) => milestoneManifest.parseMilestoneArtifact(f.text, f.name));
    const collected = milestoneManifest.collectMilestones(parsed);
    return { groups: collected.groups, errors: collected.errors };
}
/**
 * Rebuild both generated regions and return the new roadmap text.
 *
 * This is the function the generator and both SDK callers share.
 * `completionOverrides` maps a phase number to the completion date its caller
 * is stamping right now. It exists so a caller HOLDING A CLOCK, which the SDK
 * does and the pure lib deliberately does not, can supply that date without the
 * lib ever reading one. Every other current-state claim is derived from disk on
 * every run.
 *
 * A malformed region is a refusal, never an overwrite: the original text comes
 * back unchanged alongside the errors. A roadmap with no `### Phase N:` heading
 * has no source to render from, so the rebuild is a NO-OP rather than an
 * emptying, which is the only safe answer for a roadmap whose phase list is
 * bullets alone.
 */
function rebuildRoadmapRegions(cwd, roadmapText, completionOverrides, file) {
    const name = typeof file === 'string' && file !== '' ? file : 'ROADMAP.md';
    const located = roadmapIndex.locateRegions(roadmapText, name);
    // A missing notice is the bootstrap case and is not a refusal: `--write` and
    // the SDK callers both establish the region on their first run. Everything
    // else is structural and the caller must repair it by hand.
    const blocking = located.errors.filter((e) => e.code !== 'E_ROADMAP_REGION_MISSING');
    if (blocking.length > 0) {
        return { ok: false, text: roadmapText, errors: blocking };
    }
    const scanned = scanPhaseEntries(cwd, roadmapText, name);
    if (!scanned.ok) {
        return { ok: false, text: roadmapText, errors: scanned.errors };
    }
    if (scanned.entries.length === 0) {
        return { ok: true, text: roadmapText, errors: [] };
    }
    const phasesSpan = located.regions.phases;
    const progressSpan = located.regions.progress;
    const carriedLabels = phasesSpan && phasesSpan.present
        ? roadmapIndex.extractCarriedLabels(roadmapIndex.regionText(roadmapText, phasesSpan))
        : roadmapIndex.extractCarriedLabels(roadmapText);
    const carriedDates = progressSpan && progressSpan.present
        ? roadmapIndex.extractCarriedDates(roadmapIndex.regionText(roadmapText, progressSpan))
        : roadmapIndex.extractCarriedDates(roadmapText);
    const overrides = completionOverrides || {};
    const entries = scanned.entries.map((e) => {
        const carried = carriedLabels[e.number];
        const override = overrides[e.number];
        return Object.assign({}, e, {
            parenthetical: carried && carried.parenthetical ? carried.parenthetical : e.parenthetical,
            description: carried && carried.description ? carried.description : e.description,
            completedDate: override !== undefined ? override : (carriedDates[e.number] || ''),
        });
    });
    const rendered = {
        phases: roadmapIndex.renderPhaseIndex(entries),
        progress: roadmapIndex.renderProgressSection(entries),
    };
    const text = roadmapIndex.applyRegions(roadmapText, located.regions, rendered);
    return { ok: true, text, errors: [] };
}
/** Format a result-union error list the way every generator in this repo does. */
function formatErrors(errors) {
    return errors.map((e) => `  ${e.file}: [${e.code}] ${e.message}`).join('\n');
}
/**
 * The refusal message both SDK adapters print, so the 2 of them cannot drift
 * into 2 different wordings for the same failure.
 */
function rebuildFailureMessage(errors) {
    return 'ROADMAP.md carries lines inside a generated region that the renderer refuses to '
        + 'overwrite:\n'
        + formatErrors(errors)
        + '\nFix: move each line outside its region, then run:\n'
        + '  node scripts/gen-roadmap-index.cjs --write';
}
module.exports = {
    scanPhaseEntries,
    readMilestoneGroups,
    rebuildRoadmapRegions,
    phaseDirectories,
    formatErrors,
    rebuildFailureMessage,
    PENDING_STATUS,
};
