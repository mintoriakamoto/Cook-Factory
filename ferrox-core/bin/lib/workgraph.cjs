"use strict";
/**
 * workgraph: the `workgraph/v1` document contract and its pure core.
 *
 * PURE parser, resolver, classifier, orderer, assembler and validator for the
 * phase work graph (Phase 17, v1.14 Fleet Mode). Mirrors `roadmap-index.cts` in
 * shape: a vocabulary block, a result union carrying a code, explicit sorts that
 * never consult input order, an `## Honest gaps` block at the foot, and an
 * `export =` object literal.
 *
 * WHY THIS EXISTS: `.planning/MEASUREMENT-v1.14-PARALLELISM.md` replayed 10
 * phases and measured pooled true parallel width at 3.20. The dominant limiter
 * was not code coupling and not bookkeeping, it was DECLARED dependency edges
 * with nothing behind them: phases 02, 04 and 05 each named a config-block plan
 * as a prerequisite for cores that provably never imported config, and the
 * plans' own frontmatter admitted the values arrived as explicit router-supplied
 * inputs. That is worth about 0.6 of width per phase. So the highest value thing
 * this graph can do is tell a REAL edge from a DECLARED one, and say which
 * evidence backs it.
 *
 * HERMETIC BY CONTRACT (this is what makes the byte level tests real):
 *   - no filesystem module, no process spawning module, no clock, no network
 *   - callers pass source text, records and path sets in; this module reads
 *     nothing and resolves against an INJECTED set of existing paths
 *   - every emitted array is sorted EXPLICITLY, so a filesystem enumeration
 *     change upstream cannot alter the emitted bytes
 *   - `detectImpurity` below is the same property expressed as a predicate, and
 *     the test fires it at a synthetic source that DOES name a forbidden module
 *     before it fires it at this module's own build output
 *
 * FAIL LOUD: nothing here throws. A specifier that resolves to no file returns a
 * miss carrying the specifier text, and the caller records it. A scan that
 * quietly discards what it cannot resolve reports an empty import graph after a
 * rename and nobody notices.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/workgraph.cjs.
 */
// ─── the vocabulary ──────────────────────────────────────────────────────────
/** The shipped schema string. A document naming any other version is rejected. */
const SCHEMA_VERSION = 'workgraph/v1';
/** The 2 node kinds. A seam node schedules ahead of everything that needs it. */
const NODE_KINDS = ['plan', 'seam'];
/** The 3 verdicts a declared edge can carry. */
const VERDICTS = ['backed', 'unbacked', 'unproven'];
/** The 2 reasons an edge can be unproven rather than unbacked. */
const UNPROVEN_REASONS = ['out-of-scan-scope', 'endpoint-absent-from-disk'];
/** The 4 import shapes this repository actually writes. */
const IMPORT_FORMS = ['import-equals', 'esm', 'side-effect', 'require'];
/** The 4 extensions a specifier may resolve to, in candidate order. */
const SOURCE_EXTENSIONS = ['.cts', '.ts', '.cjs', '.js'];
/** Compiled output extension to the TypeScript source extension it came from. */
const COMPILED_TO_SOURCE = [
    ['.cjs', '.cts'],
    ['.mjs', '.mts'],
    ['.js', '.ts'],
];
/** A file whose name carries this marker declares types and imports no values. */
const DECLARATION_MARKER = /\.d\.[cm]?ts$/;
/** Module ids this lib must never name, checked by `detectImpurity`. */
const FORBIDDEN_MODULE_IDS = [
    'fs',
    'fs/promises',
    'child_process',
    'worker_threads',
    'net',
    'http',
    'https',
];
/** Clock reads, written as patterns so this source never carries the literal. */
const CLOCK_SHAPES = [
    /\bDate\s*\.\s*now\s*\(/,
    /\bnew\s+Date\s*\(/,
    /\bperformance\s*\.\s*now\s*\(/,
    /\bprocess\s*\.\s*hrtime\b/,
];
// ─── the import shapes ───────────────────────────────────────────────────────
//
// Anchored forms first, then the unanchored require scan as the fallback. The
// rule is: recognize the 4 shapes this repo writes, name anything else dynamic,
// and never guess. A full expression parse is not attempted and is not needed.
const IMPORT_EQUALS_SHAPE = /^\s*import\s+[A-Za-z_$][\w$]*\s*=\s*require\(\s*(['"])([^'"]*)\1\s*\)/;
const ESM_FROM_SHAPE = /^\s*import\s+(type\s+)?[^;]*?\sfrom\s*(['"])([^'"]*)\2/;
const SIDE_EFFECT_SHAPE = /^\s*import\s*(['"])([^'"]*)\1\s*;?\s*$/;
const ESM_OPEN_SHAPE = /^\s*import\s+(type\s+)?\{[^}]*$/;
const ESM_CLOSE_SHAPE = /^\s*\}\s*from\s*(['"])([^'"]*)\1/;
const BARE_REQUIRE_SHAPE = /require\(\s*(['"])([^'"]*)\1\s*\)/g;
const DYNAMIC_REQUIRE_SHAPE = /require\(\s*([A-Za-z_$][\w$.]*)\s*\)/g;
function err(code, message, subject) {
    const e = { ok: false, code, message };
    if (typeof subject === 'string' && subject !== '')
        e.subject = subject;
    return e;
}
// ─── line arithmetic ─────────────────────────────────────────────────────────
/**
 * Tolerant line split (`local/no-crlf-fragile-split`), the shipped pattern from
 * `roadmap-index.cts`. The carriage return is dropped from the line text.
 */
function splitLines(text) {
    const lines = [];
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
        if (i === text.length || text.charAt(i) === '\n') {
            let line = text.slice(start, i);
            if (line.endsWith('\r'))
                line = line.slice(0, -1);
            lines.push(line);
            start = i + 1;
            if (i === text.length)
                break;
        }
    }
    return lines;
}
/**
 * Return the code half of 1 line, with comment text removed and string literals
 * preserved, carrying block comment state across the call.
 *
 * The block state is the whole point. A doc comment in this repo can carry a
 * full import line as an example, and a scanner that inspects each line in
 * isolation manufactures an import edge out of prose. That is a false BACKED
 * verdict, which is the exact failure this module exists to detect, committed
 * by the detector itself.
 */
function stripLineComments(line, state) {
    let out = '';
    let i = 0;
    while (i < line.length) {
        if (state.inBlock) {
            const end = line.indexOf('*/', i);
            if (end === -1)
                return out;
            state.inBlock = false;
            i = end + 2;
            continue;
        }
        const ch = line.charAt(i);
        const next = line.charAt(i + 1);
        if (ch === '/' && next === '/')
            return out;
        if (ch === '/' && next === '*') {
            state.inBlock = true;
            i += 2;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            const start = i;
            i += 1;
            while (i < line.length) {
                if (line.charAt(i) === '\\') {
                    i += 2;
                    continue;
                }
                if (line.charAt(i) === ch) {
                    i += 1;
                    break;
                }
                i += 1;
            }
            out += line.slice(start, i);
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}
/** The code half of a whole source text, line structure preserved. */
function stripSourceComments(text) {
    if (typeof text !== 'string' || text === '')
        return '';
    const state = { inBlock: false };
    return splitLines(text)
        .map((line) => stripLineComments(line, state))
        .join('\n');
}
// ─── the import source parser ────────────────────────────────────────────────
function isDeclarationFile(filename) {
    return typeof filename === 'string' && DECLARATION_MARKER.test(filename);
}
function spec(specifier, form, typeOnly, line, dynamic) {
    return {
        specifier,
        form,
        type_only: typeOnly,
        external: !dynamic && !specifier.startsWith('.'),
        dynamic,
        line,
    };
}
/**
 * Every specifier the source text imports, with its form and its type_only flag.
 *
 * A specifier that lives only inside a comment produces nothing. A require call
 * whose argument is an identifier produces a DYNAMIC result carrying no
 * specifier, because the caller has to know the scan could not read it rather
 * than believe the file imports nothing.
 */
function parseImportSources(text, filename) {
    const results = [];
    if (typeof text !== 'string' || text === '')
        return { ok: true, results };
    const declared = isDeclarationFile(filename);
    const state = { inBlock: false };
    let pendingEsm = null;
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i++) {
        const code = stripLineComments(lines[i], state);
        const lineNo = i + 1;
        if (code.trim() === '')
            continue;
        if (pendingEsm !== null) {
            const close = ESM_CLOSE_SHAPE.exec(code);
            if (close !== null) {
                results.push(spec(close[2], 'esm', declared || pendingEsm.type_only, lineNo, false));
                pendingEsm = null;
                continue;
            }
            if (code.includes('}'))
                pendingEsm = null;
            continue;
        }
        const equals = IMPORT_EQUALS_SHAPE.exec(code);
        if (equals !== null) {
            results.push(spec(equals[2], 'import-equals', declared, lineNo, false));
            continue;
        }
        const esm = ESM_FROM_SHAPE.exec(code);
        if (esm !== null) {
            results.push(spec(esm[3], 'esm', declared || esm[1] !== undefined, lineNo, false));
            continue;
        }
        const side = SIDE_EFFECT_SHAPE.exec(code);
        if (side !== null) {
            results.push(spec(side[2], 'side-effect', declared, lineNo, false));
            continue;
        }
        const open = ESM_OPEN_SHAPE.exec(code);
        if (open !== null) {
            pendingEsm = { type_only: open[1] !== undefined };
            continue;
        }
        // The fallback. This covers a require bound by a declaration and a bare
        // require that is not the whole of one, which are the same shape once the
        // anchored import statements above have been taken off the line.
        BARE_REQUIRE_SHAPE.lastIndex = 0;
        let m = BARE_REQUIRE_SHAPE.exec(code);
        let matched = false;
        while (m !== null) {
            matched = true;
            results.push(spec(m[2], 'require', declared, lineNo, false));
            m = BARE_REQUIRE_SHAPE.exec(code);
        }
        if (matched)
            continue;
        DYNAMIC_REQUIRE_SHAPE.lastIndex = 0;
        let d = DYNAMIC_REQUIRE_SHAPE.exec(code);
        while (d !== null) {
            results.push(spec('', 'require', declared, lineNo, true));
            d = DYNAMIC_REQUIRE_SHAPE.exec(code);
        }
    }
    return { ok: true, results };
}
// ─── path normalization and the specifier resolver ───────────────────────────
/**
 * 1 spelling per path. Separators become the forward slash form, a leading
 * current directory prefix is stripped, empty segments collapse and parent
 * segments are folded, so the plain form, the leading dot form and the backslash
 * form of 1 path compare equal.
 */
function normalizePath(value) {
    if (typeof value !== 'string' || value === '')
        return '';
    const parts = [];
    for (const segment of value.replace(/\\/g, '/').split('/')) {
        if (segment === '' || segment === '.')
            continue;
        if (segment === '..') {
            if (parts.length > 0 && parts[parts.length - 1] !== '..')
                parts.pop();
            else
                parts.push('..');
            continue;
        }
        parts.push(segment);
    }
    return parts.join('/');
}
function dirOf(filePath) {
    const normalized = normalizePath(filePath);
    const cut = normalized.lastIndexOf('/');
    return cut === -1 ? '' : normalized.slice(0, cut);
}
/** True when the path sits at or under 1 of the scan roots. */
function isInScanRoot(filePath, scanRoots) {
    const roots = Array.isArray(scanRoots) ? scanRoots : [];
    for (const raw of roots) {
        const root = normalizePath(raw);
        if (root === '')
            continue;
        if (filePath === root || filePath.startsWith(root + '/'))
            return true;
    }
    return false;
}
function toPathSet(existing) {
    const set = new Set();
    if (existing instanceof Set) {
        for (const value of existing)
            set.add(normalizePath(value));
        return set;
    }
    if (Array.isArray(existing)) {
        for (const value of existing)
            set.add(normalizePath(value));
    }
    return set;
}
/**
 * Resolve 1 specifier against an INJECTED set of existing paths. Never reads a
 * disk. The candidate order is taken literally and the first hit wins, because a
 * resolver that collects every candidate and picks a winner later has 2 places
 * to be wrong instead of 1.
 */
function resolveSpecifier(fromPath, specifier, existing, scanRoots) {
    const from = normalizePath(fromPath);
    const raw = typeof specifier === 'string' ? specifier : '';
    const set = toPathSet(existing);
    const base = raw.startsWith('.') ? normalizePath(dirOf(from) + '/' + raw) : normalizePath(raw);
    const candidates = [base];
    for (const [compiled, source] of COMPILED_TO_SOURCE) {
        if (base.endsWith(compiled))
            candidates.push(base.slice(0, base.length - compiled.length) + source);
    }
    for (const ext of SOURCE_EXTENSIONS)
        candidates.push(base + ext);
    for (const ext of SOURCE_EXTENSIONS)
        candidates.push(base + '/index' + ext);
    for (const candidate of candidates) {
        if (candidate !== '' && set.has(candidate)) {
            return { ok: true, path: candidate, in_scan_root: isInScanRoot(candidate, scanRoots) };
        }
    }
    return { ok: false, reason: 'no-file-resolves', from, specifier: raw };
}
// ─── the hermeticity predicate ───────────────────────────────────────────────
/**
 * Every forbidden module id and clock read the source text names.
 *
 * Written as a predicate rather than as a test assertion so it can be fired at a
 * synthetic POSITIVE first. A detector observed only in its passing direction is
 * a guard nobody has proven can fire, which is the defect class this whole phase
 * is built to stop repeating.
 */
function detectImpurity(text, filename) {
    const found = [];
    if (typeof text !== 'string' || text === '')
        return found;
    for (const result of parseImportSources(text, filename).results) {
        if (!result.external)
            continue;
        const id = result.specifier.startsWith('node:') ? result.specifier.slice(5) : result.specifier;
        if (FORBIDDEN_MODULE_IDS.includes(id))
            found.push('module ' + result.specifier);
    }
    const code = stripSourceComments(text);
    for (const shape of CLOCK_SHAPES) {
        if (shape.test(code))
            found.push('clock ' + shape.source);
    }
    return found.slice().sort();
}
const KIND_SEAM = 'seam';
const KIND_PLAN = 'plan';
const PAIR_SEPARATOR = ' ';
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function laneOf(record) {
    const seen = new Set();
    for (const raw of asArray(record.write_lane)) {
        const normalized = normalizePath(raw);
        if (normalized !== '')
            seen.add(normalized);
    }
    return Array.from(seen).sort();
}
function resolveScanRoots(value) {
    const roots = asArray(value)
        .map((r) => normalizePath(r))
        .filter((r) => r !== '');
    return roots.length > 0 ? roots : ['src'];
}
function compareStrings(a, b) {
    if (a < b)
        return -1;
    if (a > b)
        return 1;
    return 0;
}
/**
 * 1 edge record per declared dependency, sorted by dependent id then
 * prerequisite id, classified against the 3 verdicts of the document contract.
 *
 * The 3 inputs are INJECTED and nothing else is consulted, which is what makes
 * the byte level tests real. Rule 4 of the contract, the unproven verdict, is
 * load bearing rather than defensive: a plan that has not executed yet has
 * created none of its files, so a classifier without it would accuse every
 * freshly planned edge, the signal would become noise, and the next person would
 * loosen the guard until it could not fire at all. An unbacked verdict is issued
 * ONLY where the scan could have seen a backing and did not.
 */
function classifyEdges(input) {
    const source = input === null || typeof input !== 'object' ? {} : input;
    const nodes = asArray(source.nodes).filter((n) => n !== null && typeof n === 'object' && typeof n.id === 'string' && n.id !== '');
    const scanRoots = resolveScanRoots(source.scan_roots);
    const existing = toPathSet(source.existing);
    const byId = new Map();
    const lanes = new Map();
    const pathToNodes = new Map();
    for (const record of nodes) {
        byId.set(record.id, record);
        const lane = laneOf(record);
        lanes.set(record.id, lane);
        for (const filePath of lane) {
            const owners = pathToNodes.get(filePath);
            if (owners === undefined)
                pathToNodes.set(filePath, [record.id]);
            else
                owners.push(record.id);
        }
    }
    // The import index, folded to node pairs once. Linear in the write lanes
    // rather than quadratic in the node count, and 1 place where a path is
    // normalized. The direction is preserved: the key is importer then imported,
    // so an import running the other way cannot launder a declared edge.
    const importBacking = new Map();
    for (const edge of asArray(source.import_edges)) {
        if (edge === null || typeof edge !== 'object')
            continue;
        const importer = normalizePath(edge.from);
        const imported = normalizePath(edge.to);
        if (importer === '' || imported === '')
            continue;
        for (const dependent of pathToNodes.get(importer) || []) {
            for (const prerequisite of pathToNodes.get(imported) || []) {
                if (dependent === prerequisite)
                    continue;
                const key = dependent + PAIR_SEPARATOR + prerequisite;
                const evidence = importBacking.get(key);
                const text = importer + ' imports ' + imported;
                if (evidence === undefined)
                    importBacking.set(key, [text]);
                else if (!evidence.includes(text))
                    evidence.push(text);
            }
        }
    }
    const inScope = (id) => (lanes.get(id) || []).some((p) => isInScanRoot(p, scanRoots));
    const onDisk = (id) => (lanes.get(id) || []).some((p) => isInScanRoot(p, scanRoots) && existing.has(p));
    const edges = [];
    const warnings = [];
    const dependents = nodes.slice().sort((a, b) => compareStrings(a.id, b.id));
    for (const dependent of dependents) {
        const declared = Array.from(new Set(asArray(dependent.depends_on))).sort(compareStrings);
        for (const prerequisiteId of declared) {
            if (typeof prerequisiteId !== 'string' || prerequisiteId === '')
                continue;
            if (!byId.has(prerequisiteId)) {
                warnings.push(`node ${dependent.id} declares depends_on ${prerequisiteId}, which is not a node in `
                    + 'this phase, so no edge is emitted for it');
                continue;
            }
            const dependentLane = lanes.get(dependent.id) || [];
            const prerequisiteLane = new Set(lanes.get(prerequisiteId) || []);
            const shared = dependentLane.filter((p) => prerequisiteLane.has(p)).sort(compareStrings);
            const imported = (importBacking.get(dependent.id + PAIR_SEPARATOR + prerequisiteId) || [])
                .slice()
                .sort(compareStrings);
            const backing = [];
            const evidence = [];
            if (shared.length > 0) {
                backing.push('file');
                for (const filePath of shared)
                    evidence.push('both write lanes name ' + filePath);
            }
            if (imported.length > 0) {
                backing.push('import');
                for (const text of imported)
                    evidence.push(text);
            }
            let verdict = 'backed';
            let unprovenReason = null;
            if (backing.length === 0) {
                if (!inScope(dependent.id) || !inScope(prerequisiteId)) {
                    verdict = 'unproven';
                    unprovenReason = 'out-of-scan-scope';
                }
                else if (!onDisk(dependent.id) || !onDisk(prerequisiteId)) {
                    verdict = 'unproven';
                    unprovenReason = 'endpoint-absent-from-disk';
                }
                else {
                    verdict = 'unbacked';
                }
            }
            edges.push({
                from: dependent.id,
                to: prerequisiteId,
                declared: true,
                verdict,
                backing,
                evidence,
                unproven_reason: unprovenReason,
            });
        }
    }
    return { edges, warnings: warnings.slice().sort(compareStrings) };
}
// ─── the total order ─────────────────────────────────────────────────────────
function kindRank(kind) {
    return kind === KIND_SEAM ? 0 : 1;
}
function waveOf(record) {
    return typeof record.wave === 'number' && Number.isFinite(record.wave) ? record.wave : 0;
}
/**
 * The total order: wave ascending, then seam before plan, then id ascending as a
 * plain string compare. Input order is never consulted, following the same
 * discipline as `sortEntries` in `roadmap-index.cts`.
 */
function computeSchedule(nodes) {
    const records = asArray(nodes).filter((n) => n !== null && typeof n === 'object' && typeof n.id === 'string' && n.id !== '');
    const sorted = records.slice().sort((a, b) => {
        const wave = waveOf(a) - waveOf(b);
        if (wave !== 0)
            return wave;
        const kind = kindRank(a.kind) - kindRank(b.kind);
        if (kind !== 0)
            return kind;
        return compareStrings(a.id, b.id);
    });
    const schedule = sorted.map((n) => n.id);
    const order = {};
    for (let i = 0; i < schedule.length; i++)
        order[schedule[i]] = i;
    return { schedule, order };
}
/**
 * Every pair that breaks the seam ordering property, derived from the nodes, the
 * write lanes, the declared edges and the import edges.
 *
 * The order is taken as an ARGUMENT rather than recomputed here, for 2 reasons.
 * The validator has to re-derive this property from a document whose order it
 * did not compute, and the declared dependent arm is otherwise a guard that
 * cannot fire: waves already come from the declared graph, so a declared
 * dependent is always later by construction. The arm that can actually occur is
 * the importing dependent with no declared edge, the hidden dependent.
 */
function deriveSeamViolations(input) {
    const source = input === null || typeof input !== 'object' ? {} : input;
    const nodes = asArray(source.nodes).filter((n) => n !== null && typeof n === 'object' && typeof n.id === 'string' && n.id !== '');
    const order = source.order === null || typeof source.order !== 'object' ? {} : source.order;
    const edges = asArray(source.edges);
    const importEdges = asArray(source.import_edges);
    const lanes = new Map();
    for (const record of nodes)
        lanes.set(record.id, new Set(laneOf(record)));
    const violations = [];
    for (const seam of nodes) {
        if (seam.kind !== KIND_SEAM)
            continue;
        const seamOrder = order[seam.id];
        if (typeof seamOrder !== 'number')
            continue;
        const seamLane = lanes.get(seam.id) || new Set();
        for (const dependent of nodes) {
            if (dependent.id === seam.id)
                continue;
            const dependentOrder = order[dependent.id];
            if (typeof dependentOrder !== 'number')
                continue;
            if (seamOrder < dependentOrder)
                continue;
            if (edges.some((e) => e !== null && typeof e === 'object' && e.from === dependent.id && e.to === seam.id)) {
                violations.push({
                    seam: seam.id,
                    dependent: dependent.id,
                    reason: `${dependent.id} declares an edge to seam ${seam.id} but does not schedule after it`,
                    importer: '',
                    imported: '',
                });
            }
            const dependentLane = lanes.get(dependent.id) || new Set();
            for (const edge of importEdges) {
                if (edge === null || typeof edge !== 'object')
                    continue;
                const importer = normalizePath(edge.from);
                const imported = normalizePath(edge.to);
                if (!dependentLane.has(importer) || !seamLane.has(imported))
                    continue;
                violations.push({
                    seam: seam.id,
                    dependent: dependent.id,
                    reason: `${dependent.id} imports the write lane of seam ${seam.id} but does not schedule after it`,
                    importer,
                    imported,
                });
            }
        }
    }
    return violations.sort((a, b) => compareStrings(a.seam, b.seam)
        || compareStrings(a.dependent, b.dependent)
        || compareStrings(a.importer, b.importer)
        || compareStrings(a.imported, b.imported));
}
// ─── the assembler ───────────────────────────────────────────────────────────
const DEFAULT_GENERATED = {
    plan_index: 'phase-plan-index',
    hot_seams: 'coordination.hot_seams',
    governance_seams: 'coordination.shared_state_paths',
    roles: 'team-manifest',
    tiers: 'model.resolve-tier',
    imports: 'workgraph require scan',
};
const DEFAULT_TIER = {
    stage: 'execute',
    tier: '',
    model_id: null,
    ladder_miss: '',
    risk_grade: '',
    risk_matched: [],
};
function countOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
/**
 * The whole document, every key present including the empty arrays.
 *
 * A key that appears only when it has content forces every consumer to handle 2
 * shapes, and the validator would then have to accept both.
 */
function assembleWorkgraph(input) {
    const source = input === null || typeof input !== 'object' ? {} : input;
    const errors = [];
    const scanRoots = resolveScanRoots(source.scan_roots);
    const records = [];
    for (const record of asArray(source.nodes)) {
        if (record === null || typeof record !== 'object' || typeof record.id !== 'string' || record.id === '') {
            errors.push(err('E_WG_NODE_MISSING_FIELD', 'a node record carries no id and is dropped'));
            continue;
        }
        records.push(record);
    }
    const classified = classifyEdges({
        nodes: records,
        import_edges: source.import_edges,
        existing: source.existing,
        scan_roots: scanRoots,
    });
    const { schedule, order } = computeSchedule(records);
    const seamViolations = deriveSeamViolations({
        nodes: records,
        edges: classified.edges,
        import_edges: source.import_edges,
        order,
    });
    const byId = new Map();
    for (const record of records)
        byId.set(record.id, record);
    const nodes = schedule.map((id, index) => {
        const record = byId.get(id);
        const kind = record.kind === KIND_SEAM ? KIND_SEAM : KIND_PLAN;
        const hotSeams = record.hot_seams === null || typeof record.hot_seams !== 'object'
            ? { decision: 'parallel-ok', matched: [] }
            : {
                decision: typeof record.hot_seams.decision === 'string' ? record.hot_seams.decision : 'parallel-ok',
                matched: asArray(record.hot_seams.matched).slice().sort(compareStrings),
            };
        const governanceSeams = record.governance_seams === null || typeof record.governance_seams !== 'object'
            ? { matched: [], files: [] }
            : {
                matched: asArray(record.governance_seams.matched).slice().sort(compareStrings),
                files: asArray(record.governance_seams.files).map(normalizePath).sort(compareStrings),
            };
        return {
            id: record.id,
            kind,
            wave: waveOf(record),
            schedule_order: index,
            task_count: countOf(record.task_count),
            autonomous: record.autonomous === true,
            has_summary: record.has_summary === true,
            write_lane: laneOf(record),
            hot_seams: hotSeams,
            governance_seams: governanceSeams,
            role: record.role === null || typeof record.role !== 'object' ? null : record.role,
            tier: record.tier === null || typeof record.tier !== 'object'
                ? Object.assign({}, DEFAULT_TIER)
                : Object.assign({}, DEFAULT_TIER, record.tier),
        };
    });
    const importEdges = asArray(source.import_edges)
        .filter((e) => e !== null && typeof e === 'object')
        .map((e) => ({
        from: normalizePath(e.from),
        to: normalizePath(e.to),
        form: typeof e.form === 'string' ? e.form : 'require',
        type_only: e.type_only === true,
    }))
        .sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to) || compareStrings(a.form, b.form));
    const scan = source.scan === null || typeof source.scan !== 'object' ? {} : source.scan;
    const warnings = asArray(source.warnings)
        .concat(classified.warnings)
        .slice()
        .sort(compareStrings);
    const document = {
        schema: SCHEMA_VERSION,
        phase: typeof source.phase === 'string' ? source.phase : '',
        generated: Object.assign({}, DEFAULT_GENERATED, source.generated, { scan_roots: scanRoots }),
        nodes,
        edges: classified.edges,
        import_edges: importEdges,
        schedule,
        seam_violations: seamViolations,
        seam_gaps: asArray(source.seam_gaps)
            .slice()
            .sort((a, b) => compareStrings(String(a.path), String(b.path)) || compareStrings(String(a.node), String(b.node))),
        unresolved_imports: asArray(source.unresolved_imports)
            .slice()
            .sort((a, b) => compareStrings(String(a.from), String(b.from)) || compareStrings(String(a.specifier), String(b.specifier))),
        scan: {
            files: countOf(scan.files),
            edges: countOf(scan.edges),
            external: countOf(scan.external),
            out_of_root: countOf(scan.out_of_root),
        },
        warnings,
    };
    return { ok: errors.length === 0, document, errors };
}
// ─── the schema validator ────────────────────────────────────────────────────
/**
 * The 15 failure modes, 1 code each. Every code is driven by its own named
 * mutation in `tests/workgraph.test.cjs`, and the test asserts the pairing is a
 * bijection: an unpaired code is a check nobody proved, and an unpaired mutation
 * is a hole.
 */
const WG_CODES = [
    'E_WG_SCHEMA_MISSING',
    'E_WG_SCHEMA_VERSION',
    'E_WG_NOT_OBJECT',
    'E_WG_NODES_NOT_ARRAY',
    'E_WG_NODE_DUPLICATE',
    'E_WG_NODE_MISSING_FIELD',
    'E_WG_NODE_BAD_KIND',
    'E_WG_EDGE_DANGLING',
    'E_WG_EDGE_SELF',
    'E_WG_EDGE_UNEVIDENCED',
    'E_WG_EDGE_BAD_VERDICT',
    'E_WG_WAVE_INVERSION',
    'E_WG_SEAM_AFTER_DEPENDENT',
    'E_WG_SCHEDULE_INCOMPLETE',
    'E_WG_IMPORT_OUT_OF_SCOPE',
];
/** Every key a node must carry. `role` is nullable, so presence is what counts. */
const REQUIRED_NODE_FIELDS = [
    'id',
    'kind',
    'wave',
    'schedule_order',
    'task_count',
    'autonomous',
    'has_summary',
    'write_lane',
    'hot_seams',
    'governance_seams',
    'role',
    'tier',
];
function violationKey(v) {
    return [v.seam, v.dependent, v.importer, v.imported].join(PAIR_SEPARATOR);
}
/**
 * The document contract restated as a predicate. Never throws, including on a
 * null, a string, a number and an array.
 *
 * The seam ordering property is RE-DERIVED from the nodes, the write lanes and
 * the import edges rather than read out of the document's own violations array.
 * A document that computed a violation and then failed to report it is the only
 * interesting way for the seam rule to fail, and a validator that trusted the
 * array would be a guard that cannot fire.
 */
function validateWorkgraph(doc) {
    const errors = [];
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        errors.push(err('E_WG_NOT_OBJECT', 'a workgraph document must be a plain object'));
        return { ok: false, errors };
    }
    const document = doc;
    if (!Object.prototype.hasOwnProperty.call(document, 'schema')) {
        errors.push(err('E_WG_SCHEMA_MISSING', 'the document carries no schema key'));
    }
    else if (document.schema !== SCHEMA_VERSION) {
        errors.push(err('E_WG_SCHEMA_VERSION', `the document names schema ${JSON.stringify(document.schema)}, and only `
            + `${JSON.stringify(SCHEMA_VERSION)} is shipped`));
    }
    const nodes = document.nodes;
    const nodeIds = new Set();
    const waveById = new Map();
    if (!Array.isArray(nodes)) {
        errors.push(err('E_WG_NODES_NOT_ARRAY', 'the nodes key is not an array'));
    }
    else {
        const seenOrders = new Set();
        for (const record of nodes) {
            if (record === null || typeof record !== 'object') {
                errors.push(err('E_WG_NODE_MISSING_FIELD', 'a node entry is not an object'));
                continue;
            }
            const entry = record;
            const id = typeof entry.id === 'string' ? entry.id : '';
            for (const field of REQUIRED_NODE_FIELDS) {
                if (!Object.prototype.hasOwnProperty.call(entry, field)) {
                    errors.push(err('E_WG_NODE_MISSING_FIELD', `node ${id} carries no ${field} key`, id));
                }
            }
            if (id !== '') {
                if (nodeIds.has(id)) {
                    errors.push(err('E_WG_NODE_DUPLICATE', `2 nodes carry the id ${id}`, id));
                }
                nodeIds.add(id);
                if (typeof entry.wave === 'number')
                    waveById.set(id, entry.wave);
            }
            if (typeof entry.schedule_order === 'number') {
                if (seenOrders.has(entry.schedule_order)) {
                    errors.push(err('E_WG_NODE_DUPLICATE', `2 nodes carry the schedule order ${entry.schedule_order}, and it is unique`, id));
                }
                seenOrders.add(entry.schedule_order);
            }
            if (!NODE_KINDS.includes(entry.kind)) {
                errors.push(err('E_WG_NODE_BAD_KIND', `node ${id} carries kind ${JSON.stringify(entry.kind)}`, id));
            }
        }
    }
    const edges = Array.isArray(document.edges) ? document.edges : [];
    for (const edge of edges) {
        if (edge === null || typeof edge !== 'object')
            continue;
        const label = `${edge.from} to ${edge.to}`;
        if (edge.from === edge.to) {
            errors.push(err('E_WG_EDGE_SELF', `edge ${label} names 1 node as its own prerequisite`, label));
        }
        else if (Array.isArray(nodes)) {
            if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
                errors.push(err('E_WG_EDGE_DANGLING', `edge ${label} names an id absent from the nodes`, label));
            }
        }
        const verdict = edge.verdict;
        const backing = Array.isArray(edge.backing) ? edge.backing : [];
        const evidence = Array.isArray(edge.evidence) ? edge.evidence : [];
        const reason = edge.unproven_reason;
        if (!VERDICTS.includes(verdict)) {
            errors.push(err('E_WG_EDGE_BAD_VERDICT', `edge ${label} carries verdict ${JSON.stringify(verdict)}`, label));
        }
        else if (verdict === 'unproven' && !UNPROVEN_REASONS.includes(reason)) {
            errors.push(err('E_WG_EDGE_BAD_VERDICT', `edge ${label} is unproven and names no valid reason`, label));
        }
        else if (verdict !== 'unproven' && reason !== null) {
            errors.push(err('E_WG_EDGE_BAD_VERDICT', `edge ${label} is ${verdict} and still names an unproven reason`, label));
        }
        if (verdict !== 'backed' && backing.length > 0) {
            errors.push(err('E_WG_EDGE_BAD_VERDICT', `edge ${label} is ${verdict} and still names a backing`, label));
        }
        if (verdict === 'backed' && (evidence.length === 0 || backing.length === 0)) {
            errors.push(err('E_WG_EDGE_UNEVIDENCED', `edge ${label} claims a backed verdict and names no reason behind it`, label));
        }
        const dependentWave = waveById.get(edge.from);
        const prerequisiteWave = waveById.get(edge.to);
        if (typeof dependentWave === 'number' && typeof prerequisiteWave === 'number') {
            if (prerequisiteWave > dependentWave) {
                errors.push(err('E_WG_WAVE_INVERSION', `edge ${label} names a prerequisite in wave ${prerequisiteWave} for a dependent in `
                    + `wave ${dependentWave}`, label));
            }
        }
    }
    const schedule = document.schedule;
    if (!Array.isArray(schedule)) {
        errors.push(err('E_WG_SCHEDULE_INCOMPLETE', 'the schedule key is not an array'));
    }
    else if (Array.isArray(nodes)) {
        const scheduled = new Set(schedule);
        for (const id of nodeIds) {
            if (!scheduled.has(id)) {
                errors.push(err('E_WG_SCHEDULE_INCOMPLETE', `node ${id} is absent from the schedule`, id));
            }
        }
        for (const id of schedule) {
            if (!nodeIds.has(id)) {
                errors.push(err('E_WG_SCHEDULE_INCOMPLETE', `the schedule names ${id}, which is not a node`, id));
            }
        }
        for (const record of nodes) {
            if (record === null || typeof record !== 'object')
                continue;
            const entry = record;
            if (typeof entry.id !== 'string' || typeof entry.schedule_order !== 'number')
                continue;
            if (schedule.indexOf(entry.id) !== entry.schedule_order) {
                errors.push(err('E_WG_SCHEDULE_INCOMPLETE', `node ${entry.id} claims schedule order ${entry.schedule_order} and sits elsewhere in `
                    + 'the schedule', entry.id));
            }
        }
    }
    const generated = document.generated === null || typeof document.generated !== 'object'
        ? {}
        : document.generated;
    const scanRoots = resolveScanRoots(generated.scan_roots);
    const importEdges = Array.isArray(document.import_edges)
        ? document.import_edges
        : [];
    for (const edge of importEdges) {
        if (edge === null || typeof edge !== 'object')
            continue;
        const from = normalizePath(edge.from);
        const to = normalizePath(edge.to);
        if (!isInScanRoot(from, scanRoots) || !isInScanRoot(to, scanRoots)) {
            errors.push(err('E_WG_IMPORT_OUT_OF_SCOPE', `import edge ${from} to ${to} leaves the declared scan roots ${scanRoots.join(', ')}`, from + PAIR_SEPARATOR + to));
        }
    }
    if (Array.isArray(nodes)) {
        const order = {};
        for (const record of nodes) {
            if (record === null || typeof record !== 'object')
                continue;
            const entry = record;
            if (typeof entry.id === 'string' && typeof entry.schedule_order === 'number') {
                order[entry.id] = entry.schedule_order;
            }
        }
        const implied = deriveSeamViolations({
            nodes: nodes,
            edges,
            import_edges: importEdges,
            order,
        });
        const reported = new Set((Array.isArray(document.seam_violations) ? document.seam_violations : [])
            .filter((v) => v !== null && typeof v === 'object')
            .map(violationKey));
        for (const violation of implied) {
            if (reported.has(violationKey(violation)))
                continue;
            errors.push(err('E_WG_SEAM_AFTER_DEPENDENT', `seam ${violation.seam} does not schedule before ${violation.dependent}, and the `
                + 'document reports no violation for the pair', violation.seam + PAIR_SEPARATOR + violation.dependent));
        }
    }
    return { ok: errors.length === 0, errors };
}
module.exports = {
    parseImportSources,
    resolveSpecifier,
    normalizePath,
    stripSourceComments,
    detectImpurity,
    splitLines,
    isInScanRoot,
    classifyEdges,
    computeSchedule,
    deriveSeamViolations,
    assembleWorkgraph,
    validateWorkgraph,
    err,
    WG_CODES,
    SCHEMA_VERSION,
    NODE_KINDS,
    VERDICTS,
    UNPROVEN_REASONS,
    IMPORT_FORMS,
    SOURCE_EXTENSIONS,
    FORBIDDEN_MODULE_IDS,
};
