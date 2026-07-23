"use strict";
/**
 * TEAM-01 team-manifest/v1 parser + mutation primitives (v1.13 Part 2 Wave 0).
 *
 * .planning/TEAM.md is the SINGLE roster manifest (locked decision 5): human
 * prose wrapped around exactly 1 fenced block opened by a line reading
 * "```yaml team-manifest". This lib owns only that block; the prose around it
 * is preserved byte for byte (the canon-facts keeper pattern).
 *
 * Exports:
 *   parseTeamManifest(markdown, options): locate the single team block, parse
 *     the YAML, run the deterministic validators (A3/A10), and return typed
 *     roles. Never throws on bad input: problems come back as
 *     { ok: false, errors: [{ code, path, message }], warnings: [...] }.
 *   validateTeamManifest(doc, options): the same validators over an already
 *     parsed manifest object (the mutation ops re-validate through this).
 *   computeTeamManifestHash / verifyTeamManifestHash: the A2 staleness guard.
 *     The hash is sha256 hex over a stable canonical serialization of the
 *     DECLARED manifest data (manifest_hash itself excluded), so planner
 *     stamps and dispatch re-validation can detect a drifted roster.
 *   addTeamRole / removeTeamRole / swapTeamRole: pure mutation ops. Each
 *     applies the change in memory, re-validates the RESULT, refuses invalid
 *     results (returns errors, never a broken manifest), and recomputes
 *     manifest_hash. remove/swap take an injected list of plan role
 *     references and refuse (or warn under force) when the role id is live
 *     in a stamped plan (A8).
 *   serializeTeamManifest(manifest, markdown?): stable-ordered emission.
 *     With markdown, splice the block body between the existing fence lines,
 *     prose preserved; without, emit a fresh minimal TEAM.md document.
 *
 * Purity: the lib reads no config, no fs, no env, no clock. The tier ladder
 * and the agent roster are INJECTED as options (A10); plan role references
 * are INJECTED into the mutation ops (A8). Unknown tier or unknown agent is
 * a WARNING, never an error: ladders are config-local, and an unknown agent
 * degrades the role to the inline-charter rung.
 *
 * Mutation API discipline adapted from ijfw (Sean Donahoe, internal):
 * add/remove/swap each re-validate the result and refuse to produce an
 * invalid charter. Validator field shapes informed by the same internal
 * source.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/team-manifest.cjs
 * (tracked, the canon-facts.cjs precedent). `export =` CJS shape; no stdout.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_crypto_1 = __importDefault(require("node:crypto"));
// Vendored pinned copy (ferrox-core/bin/vendor/), NOT node_modules: the
// installed ferrox-core tree is a file copy with no dependency manifest, so a
// bare package require here kills the whole CLI at startup on user machines
// (shipped broken 1.9.0 through 1.11.0). Team parsing stays self-contained.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('../vendor/js-yaml-4.2.0.cjs');
const TEAM_INFO = 'yaml team-manifest';
const TEAM_SCHEMA = 'team-manifest/v1';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The brainstorm Decisions exit marker (brainstorm-intake.cts PROVENANCE_RE):
// blessed roles carry the same exit provenance shape (A1).
const PROVENANCE_RE = /\(stance:\s*(guided|generative|sounding-board)\s*,\s*confirmed at exit\)\s*\.?\s*$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const CODES = {
    E_TEAM_BLOCK_MISSING: 'E_TEAM_BLOCK_MISSING',
    E_TEAM_BLOCK_MULTIPLE: 'E_TEAM_BLOCK_MULTIPLE',
    E_YAML_PARSE: 'E_YAML_PARSE',
    E_BAD_SCHEMA: 'E_BAD_SCHEMA',
    E_BAD_DERIVED_FROM: 'E_BAD_DERIVED_FROM',
    E_BAD_HASH: 'E_BAD_HASH',
    E_HASH_MISMATCH: 'E_HASH_MISMATCH',
    E_FLOOR_VIOLATION: 'E_FLOOR_VIOLATION',
    E_BAD_ROLE: 'E_BAD_ROLE',
    E_BAD_ROLE_ID: 'E_BAD_ROLE_ID',
    E_DUPLICATE_ROLE_ID: 'E_DUPLICATE_ROLE_ID',
    E_BAD_CHARTER: 'E_BAD_CHARTER',
    E_BAD_RATIONALE: 'E_BAD_RATIONALE',
    E_BAD_NON_REDUNDANCY: 'E_BAD_NON_REDUNDANCY',
    E_BAD_PROVENANCE: 'E_BAD_PROVENANCE',
    E_BAD_BINDING: 'E_BAD_BINDING',
    E_MISSING_TIER: 'E_MISSING_TIER',
    E_BAD_TIER: 'E_BAD_TIER',
    // Covers malformed surface lists AND unsupported glob syntax: owns[] and
    // reviews[] allow only `*`, `?`, `**` over `/`-separated segments
    // (case-insensitive); `{`, `[`, and `\` are refused fail-closed because the
    // overlap engine cannot evaluate them.
    E_BAD_SURFACE: 'E_BAD_SURFACE',
    E_EMPTY_SURFACES: 'E_EMPTY_SURFACES',
    E_BAD_PHASE_SCOPE: 'E_BAD_PHASE_SCOPE',
    E_OWNS_OVERLAP: 'E_OWNS_OVERLAP',
    E_BAD_MANIFEST: 'E_BAD_MANIFEST',
    E_ROLE_EXISTS: 'E_ROLE_EXISTS',
    E_ROLE_NOT_FOUND: 'E_ROLE_NOT_FOUND',
    E_ROLE_LIVE_IN_PLAN: 'E_ROLE_LIVE_IN_PLAN',
    W_UNKNOWN_TIER: 'W_UNKNOWN_TIER',
    W_UNKNOWN_AGENT: 'W_UNKNOWN_AGENT',
    W_ROLE_LIVE_IN_PLAN: 'W_ROLE_LIVE_IN_PLAN',
};
// Mutation-op-only refusals: parseTeamManifest can never evaluate these, so
// the station-floor "K/K checks" denominator must exclude them or the receipt
// overcounts. PARSE_CODES is the honest denominator set.
const MUTATION_ONLY_CODES = [
    CODES.E_ROLE_EXISTS,
    CODES.E_ROLE_NOT_FOUND,
    CODES.E_ROLE_LIVE_IN_PLAN,
];
/** The E_ codes a parse/validate pass can actually evaluate (receipt denominator). */
const PARSE_CODES = Object.keys(CODES).filter((c) => c.startsWith('E_') && !MUTATION_ONLY_CODES.includes(c));
// Same CommonMark delimiter rules as the canon-facts keeper (fence run of 3 or
// more backticks or tildes, up to 3 spaces of indent, a closer must match the
// opener's char with run length >= the opener and no trailing text). Line
// positions are needed to splice the block body back, so this is the same
// tracked duplication of the sectionizer engine as canon-facts.cts.
const FENCE_DELIM_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** PURE. Locate every fenced block whose info string is `yaml team-manifest`. */
function findTeamBlocks(lines) {
    const blocks = [];
    let open = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, '');
        const m = FENCE_DELIM_RE.exec(line);
        if (m === null)
            continue;
        const char = m[1][0];
        const len = m[1].length;
        const trailing = m[2];
        if (open === null) {
            // CommonMark 4.5: a backtick fence info string must not contain a backtick.
            if (char === '`' && trailing.includes('`'))
                continue;
            open = { char, len, isTeam: trailing.trim().toLowerCase() === TEAM_INFO, openIdx: i };
        }
        else if (char === open.char && len >= open.len && /^\s*$/.test(trailing)) {
            if (open.isTeam)
                blocks.push({ openIdx: open.openIdx, closeIdx: i });
            open = null;
        }
        // else: mismatched delimiter inside an open fence is content, not a boundary
    }
    if (open !== null && open.isTeam)
        blocks.push({ openIdx: open.openIdx, closeIdx: -1 });
    return blocks;
}
// ---------- shared helpers ----------
function isRecord(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function nonEmptyString(v) {
    return typeof v === 'string' && v.trim() !== '';
}
function stringList(v) {
    if (!Array.isArray(v))
        return null;
    const out = [];
    for (const item of v) {
        if (!nonEmptyString(item))
            return null;
        out.push(item);
    }
    return out;
}
function push(list, code, path, message) {
    list.push({ code, path, message });
}
// ---------- glob overlap (A3 deterministic teeth) ----------
/**
 * Decide whether 2 single path segments (with `*` and `?` wildcards) can both
 * match some common string. Memoized character-level recursion: a `*` on
 * either side may absorb any run of the other side's characters.
 */
function segmentsCoMatch(p, q) {
    const memo = new Map();
    const co = (i, j) => {
        const key = i * (q.length + 1) + j;
        const hit = memo.get(key);
        if (hit !== undefined)
            return hit;
        let r;
        if (i === p.length && j === q.length) {
            r = true;
        }
        else if (i < p.length && p[i] === '*') {
            r = co(i + 1, j) || (j < q.length && co(i, j + 1));
        }
        else if (j < q.length && q[j] === '*') {
            r = co(i, j + 1) || (i < p.length && co(i + 1, j));
        }
        else if (i < p.length && j < q.length && (p[i] === '?' || q[j] === '?' || p[i] === q[j])) {
            r = co(i + 1, j + 1);
        }
        else {
            r = false;
        }
        memo.set(key, r);
        return r;
    };
    return co(0, 0);
}
function globSegments(glob) {
    return glob.trim().toLowerCase().replace(/^\.\//, '').split('/').filter((s) => s !== '');
}
// Fail-closed surface syntax (A3): the overlap engine understands only `*`,
// `?`, and `**` over `/`-separated segments, compared case-insensitively.
// Brace expansion, character classes, and backslashes would silently
// false-negative the overlap check, so validation REFUSES them outright.
const UNSUPPORTED_GLOB_RE = /[{[\\]/;
/**
 * PURE. True when a common concrete path could match BOTH globs. Segments
 * split on `/`; a `**` segment matches 0 or more whole segments; `*` and `?`
 * match within a single segment. Comparison is case-insensitive (2 owns
 * surfaces differing only in case still collide on case-insensitive
 * filesystems). Deterministic memoized recursion. Supported syntax is only
 * `*`, `?`, and `**`; validation rejects anything else (fail closed).
 */
function globsOverlap(a, b) {
    const A = globSegments(a);
    const B = globSegments(b);
    const memo = new Map();
    const overlap = (i, j) => {
        const key = i * (B.length + 1) + j;
        const hit = memo.get(key);
        if (hit !== undefined)
            return hit;
        let r;
        if (i === A.length && j === B.length) {
            r = true;
        }
        else if (i === A.length) {
            r = B.slice(j).every((s) => s === '**');
        }
        else if (j === B.length) {
            r = A.slice(i).every((s) => s === '**');
        }
        else if (A[i] === '**') {
            r = overlap(i + 1, j) || overlap(i, j + 1);
        }
        else if (B[j] === '**') {
            r = overlap(i, j + 1) || overlap(i + 1, j);
        }
        else {
            r = segmentsCoMatch(A[i], B[j]) && overlap(i + 1, j + 1);
        }
        memo.set(key, r);
        return r;
    };
    return overlap(0, 0);
}
// ---------- role + manifest validation ----------
function validateRole(raw, at, errors, warnings, options) {
    if (!isRecord(raw)) {
        push(errors, CODES.E_BAD_ROLE, at, 'role must be a mapping');
        return null;
    }
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!SLUG_RE.test(id)) {
        push(errors, CODES.E_BAD_ROLE_ID, `${at}.id`, `role id must be a kebab-case slug, got ${JSON.stringify(raw.id)}`);
    }
    if (!nonEmptyString(raw.charter)) {
        push(errors, CODES.E_BAD_CHARTER, `${at}.charter`, 'charter is the trusted role text and must be a non-empty string');
    }
    if (!nonEmptyString(raw.rationale)) {
        push(errors, CODES.E_BAD_RATIONALE, `${at}.rationale`, 'rationale must be a non-empty string tied to the brief');
    }
    if (!nonEmptyString(raw.non_redundancy)) {
        push(errors, CODES.E_BAD_NON_REDUNDANCY, `${at}.non_redundancy`, 'every role must state its non-redundancy (floor-of-1 discipline)');
    }
    if (!nonEmptyString(raw.provenance) || !PROVENANCE_RE.test(raw.provenance)) {
        push(errors, CODES.E_BAD_PROVENANCE, `${at}.provenance`, 'provenance must carry the exit-confirmed marker "(stance: <stance>, confirmed at exit)" (A1: unblessed roles are notes, never manifest rows)');
    }
    // binding: exactly 1 of { agent: <name> } or { inline: true }
    let binding = null;
    let effective = 'inline';
    if (isRecord(raw.binding)) {
        const hasAgent = nonEmptyString(raw.binding.agent);
        const hasInline = raw.binding.inline === true;
        if (hasAgent && !hasInline) {
            binding = { agent: raw.binding.agent };
            effective = 'agent';
        }
        else if (hasInline && !hasAgent) {
            binding = { inline: true };
        }
    }
    if (binding === null) {
        push(errors, CODES.E_BAD_BINDING, `${at}.binding`, 'binding must be exactly 1 of { agent: <name> } or { inline: true }');
    }
    // A10: unknown agent is a warning and the role degrades to the inline rung.
    if (effective === 'agent' && Array.isArray(options.agents)) {
        const agent = binding.agent;
        if (!options.agents.includes(agent)) {
            push(warnings, CODES.W_UNKNOWN_AGENT, `${at}.binding.agent`, `agent ${JSON.stringify(agent)} is not in the injected agent list; role degrades to the inline-charter rung`);
            effective = 'inline';
        }
    }
    // tier: REQUIRED for inline-DECLARED roles, OPTIONAL for agent-bound roles
    // (A14: the catalog default applies downstream). The requirement keys off
    // the DECLARED binding: an unknown-agent degrade must not flip a warning
    // into a schema error.
    const declaredInline = binding !== null && 'inline' in binding;
    let tier = null;
    if (raw.tier === undefined || raw.tier === null) {
        if (declaredInline) {
            push(errors, CODES.E_MISSING_TIER, `${at}.tier`, 'tier is required for inline roles (agent-bound roles may omit it, A14)');
        }
    }
    else if (!nonEmptyString(raw.tier)) {
        push(errors, CODES.E_BAD_TIER, `${at}.tier`, 'tier must be a non-empty string when present');
    }
    else {
        tier = raw.tier;
        // A10: ladders are config-local, so an unknown tier warns, never refuses.
        if (Array.isArray(options.tiers) && !options.tiers.includes(tier)) {
            push(warnings, CODES.W_UNKNOWN_TIER, `${at}.tier`, `tier ${JSON.stringify(tier)} is not in the injected tier list; dispatch will receipt the ladder miss loudly`);
        }
    }
    const owns = raw.owns === undefined || raw.owns === null ? [] : stringList(raw.owns);
    if (owns === null) {
        push(errors, CODES.E_BAD_SURFACE, `${at}.owns`, 'owns must be a list of non-empty path globs');
    }
    const reviews = raw.reviews === undefined || raw.reviews === null ? [] : stringList(raw.reviews);
    if (reviews === null) {
        push(errors, CODES.E_BAD_SURFACE, `${at}.reviews`, 'reviews must be a list of non-empty path globs');
    }
    // Fail closed on glob syntax the overlap engine cannot evaluate: allowed
    // syntax is `*`, `?`, and `**` over `/`-separated segments (matched
    // case-insensitively); `{`, `[`, and `\` are refused.
    for (const [key, list] of [['owns', owns], ['reviews', reviews]]) {
        if (list === null)
            continue;
        for (let i = 0; i < list.length; i++) {
            if (UNSUPPORTED_GLOB_RE.test(list[i])) {
                push(errors, CODES.E_BAD_SURFACE, `${at}.${key}[${i}]`, `unsupported glob syntax in ${JSON.stringify(list[i])}: allowed syntax is *, ?, and ** over /-separated segments (case-insensitive); {, [, and \\ are refused so the overlap check can never silently false-negative (fail closed)`);
            }
        }
    }
    if (owns !== null && reviews !== null && owns.length === 0 && reviews.length === 0) {
        push(errors, CODES.E_EMPTY_SURFACES, at, 'every role needs a non-empty owns or reviews surface (A3)');
    }
    let phaseScope = null;
    if (raw.phase_scope !== undefined && raw.phase_scope !== null) {
        phaseScope = stringList(raw.phase_scope);
        if (phaseScope === null) {
            push(errors, CODES.E_BAD_PHASE_SCOPE, `${at}.phase_scope`, 'phase_scope must be a list of non-empty strings when present');
        }
    }
    return {
        id,
        charter: typeof raw.charter === 'string' ? raw.charter : '',
        rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
        non_redundancy: typeof raw.non_redundancy === 'string' ? raw.non_redundancy : '',
        provenance: typeof raw.provenance === 'string' ? raw.provenance : '',
        binding: binding ?? { inline: true },
        effective_binding: effective,
        tier,
        owns: owns ?? [],
        reviews: reviews ?? [],
        phase_scope: phaseScope,
    };
}
/**
 * A3: no 2 roles may hold overlapping owns globs UNLESS 1 side's reviews[]
 * covers the other's overlapping owns surface (the explicit review edge).
 */
function checkOwnsOverlap(roles, errors) {
    for (let i = 0; i < roles.length; i++) {
        for (let j = i + 1; j < roles.length; j++) {
            const a = roles[i];
            const b = roles[j];
            for (const ga of a.owns) {
                for (const gb of b.owns) {
                    if (!globsOverlap(ga, gb))
                        continue;
                    const edge = a.reviews.some((r) => globsOverlap(r, gb)) ||
                        b.reviews.some((r) => globsOverlap(r, ga));
                    if (!edge) {
                        push(errors, CODES.E_OWNS_OVERLAP, `roles[${j}].owns`, `roles ${a.id || `#${i}`} and ${b.id || `#${j}`} both own overlapping surfaces (${JSON.stringify(ga)} vs ${JSON.stringify(gb)}) with no review edge covering the overlap`);
                    }
                }
            }
        }
    }
}
/**
 * PURE. Validate an already parsed team-manifest document object. Used by
 * parseTeamManifest after YAML load and by every mutation op on its RESULT.
 * `checkHash` is skipped by the mutation ops (they recompute the hash last).
 */
function validateTeamManifest(doc, options, internal) {
    const errors = [];
    const warnings = [];
    const opts = options ?? {};
    const fail = () => ({ ok: false, manifest: null, errors, warnings });
    if (!isRecord(doc)) {
        push(errors, CODES.E_BAD_MANIFEST, '', 'manifest must be a mapping');
        return fail();
    }
    if (doc.schema !== TEAM_SCHEMA) {
        push(errors, CODES.E_BAD_SCHEMA, 'schema', `schema must be ${TEAM_SCHEMA}, got ${JSON.stringify(doc.schema)}`);
        return fail();
    }
    const df = doc.derived_from;
    let derivedFrom = { brainstorm: '', milestone: '' };
    if (!isRecord(df) || !nonEmptyString(df.brainstorm) || !nonEmptyString(df.milestone)) {
        push(errors, CODES.E_BAD_DERIVED_FROM, 'derived_from', 'derived_from requires non-empty brainstorm and milestone strings (A4 scope matching)');
    }
    else {
        derivedFrom = { brainstorm: df.brainstorm, milestone: df.milestone };
    }
    const rolesRaw = doc.roles;
    const roles = [];
    if (!Array.isArray(rolesRaw)) {
        push(errors, CODES.E_FLOOR_VIOLATION, 'roles', 'roles must be a list with at least 1 role (floor of 1)');
    }
    else if (rolesRaw.length === 0) {
        push(errors, CODES.E_FLOOR_VIOLATION, 'roles', 'a team needs at least 1 role (floor of 1)');
    }
    else {
        const seen = new Set();
        for (let i = 0; i < rolesRaw.length; i++) {
            const role = validateRole(rolesRaw[i], `roles[${i}]`, errors, warnings, opts);
            if (role === null)
                continue;
            if (role.id !== '' && seen.has(role.id)) {
                push(errors, CODES.E_DUPLICATE_ROLE_ID, `roles[${i}].id`, `duplicate role id ${role.id}`);
            }
            if (role.id !== '')
                seen.add(role.id);
            roles.push(role);
        }
        checkOwnsOverlap(roles, errors);
    }
    const manifest = {
        schema: TEAM_SCHEMA,
        derived_from: derivedFrom,
        manifest_hash: typeof doc.manifest_hash === 'string' ? doc.manifest_hash : '',
        roles,
    };
    if (internal?.skipHashCheck !== true) {
        if (!HASH_RE.test(manifest.manifest_hash)) {
            push(errors, CODES.E_BAD_HASH, 'manifest_hash', 'manifest_hash must be a 64-char sha256 hex string (A2 staleness guard)');
        }
        else if (errors.length === 0) {
            // Only meaningful over a structurally valid manifest.
            const expected = computeHashOf(manifest);
            if (expected !== manifest.manifest_hash) {
                push(errors, CODES.E_HASH_MISMATCH, 'manifest_hash', `manifest_hash ${manifest.manifest_hash.slice(0, 12)}... does not match the roster content (expected ${expected.slice(0, 12)}...); mutate through the governed ops, never by hand`);
            }
        }
    }
    return { ok: errors.length === 0, manifest: errors.length === 0 ? manifest : null, errors, warnings };
}
// ---------- manifest hash (A2) ----------
/**
 * Build the canonical hashable form: fixed key order, DECLARED data only.
 * manifest_hash itself and the derived effective_binding are excluded, so a
 * hand-recomputed hash and a parse-derived hash always agree.
 */
function canonicalForm(manifest) {
    return {
        schema: manifest.schema,
        derived_from: {
            brainstorm: manifest.derived_from.brainstorm,
            milestone: manifest.derived_from.milestone,
        },
        roles: manifest.roles.map((r) => ({
            id: r.id,
            charter: r.charter,
            rationale: r.rationale,
            non_redundancy: r.non_redundancy,
            provenance: r.provenance,
            binding: 'agent' in r.binding ? { agent: r.binding.agent } : { inline: true },
            tier: r.tier,
            owns: r.owns,
            reviews: r.reviews,
            phase_scope: r.phase_scope,
        })),
    };
}
/** Internal: hash a manifest already known to be manifest-shaped. */
function computeHashOf(manifest) {
    return node_crypto_1.default.createHash('sha256').update(JSON.stringify(canonicalForm(manifest)), 'utf8').digest('hex');
}
/**
 * PURE. sha256 hex over the stable canonical serialization of the roster.
 * Never throws: guarded like verifyTeamManifestHash, a non-manifest input
 * (null, {}, garbage roles) comes back as null instead of a TypeError.
 */
function computeTeamManifestHash(manifest) {
    if (!isRecord(manifest) || !isRecord(manifest.derived_from) || !Array.isArray(manifest.roles))
        return null;
    if (!manifest.roles.every((r) => isRecord(r) && isRecord(r.binding)))
        return null;
    return computeHashOf(manifest);
}
/** PURE. Recompute and compare. Never throws: a garbage input compares false. */
function verifyTeamManifestHash(manifest) {
    if (!isRecord(manifest))
        return { ok: false, expected: null, actual: null };
    const checked = validateTeamManifest(manifest, undefined, { skipHashCheck: true });
    if (checked.manifest === null)
        return { ok: false, expected: null, actual: null };
    const expected = computeHashOf(checked.manifest);
    const declared = manifest.manifest_hash;
    const actual = typeof declared === 'string' ? declared : null;
    return { ok: expected === actual, expected, actual };
}
// ---------- parseTeamManifest ----------
/**
 * Parse a TEAM.md document. Extracts the single fenced `yaml team-manifest`
 * block, parses its YAML, and runs every deterministic validator (A3/A10).
 * The tier ladder and agent roster arrive INJECTED via options; the lib
 * itself reads no config. NEVER throws on bad input.
 */
function parseTeamManifest(markdown, options) {
    const errors = [];
    const warnings = [];
    const fail = () => ({ ok: false, manifest: null, errors, warnings });
    if (typeof markdown !== 'string' || markdown === '') {
        push(errors, CODES.E_TEAM_BLOCK_MISSING, '', 'input is not a non-empty string');
        return fail();
    }
    const lines = markdown.split('\n');
    const blocks = findTeamBlocks(lines);
    const closedBlocks = blocks.filter((b) => b.closeIdx !== -1);
    if (blocks.length === 0) {
        push(errors, CODES.E_TEAM_BLOCK_MISSING, '', 'no fenced yaml team-manifest block found');
        return fail();
    }
    if (blocks.length > 1) {
        push(errors, CODES.E_TEAM_BLOCK_MULTIPLE, '', `expected exactly 1 team block, found ${blocks.length}`);
        return fail();
    }
    if (closedBlocks.length === 0) {
        push(errors, CODES.E_TEAM_BLOCK_MISSING, '', 'the team block is unterminated (no closing fence)');
        return fail();
    }
    const block = closedBlocks[0];
    const inner = lines.slice(block.openIdx + 1, block.closeIdx).join('\n');
    let raw;
    try {
        // js-yaml v4 load() is safe by default (no code-executing tags).
        raw = yaml.load(inner);
    }
    catch (e) {
        push(errors, CODES.E_YAML_PARSE, '', `YAML parse failed: ${String(e.message)}`);
        return fail();
    }
    const result = validateTeamManifest(raw, options);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    return { ok: result.ok, manifest: result.manifest, errors, warnings };
}
// ---------- mutation ops (A8; ijfw modify.js discipline) ----------
function normalizePlanRefs(refs) {
    if (!Array.isArray(refs))
        return [];
    const out = [];
    for (const r of refs) {
        if (typeof r === 'string' && r !== '') {
            out.push({ role_id: r, file: null });
        }
        else if (isRecord(r) && nonEmptyString(r.role_id)) {
            out.push({ role_id: r.role_id, file: nonEmptyString(r.file) ? r.file : null });
        }
    }
    return out;
}
/**
 * A8 live-plan guard shared by remove/swap. Returns true when the op must
 * refuse; under force the refusal downgrades to a warning and the op proceeds.
 */
function planRefGuard(roleId, opName, options, errors, warnings) {
    const live = normalizePlanRefs(options.planRoleRefs).filter((r) => r.role_id === roleId);
    if (live.length === 0)
        return false;
    const where = live
        .map((r) => r.file ?? 'a stamped plan')
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .join(', ');
    if (options.force === true) {
        push(warnings, CODES.W_ROLE_LIVE_IN_PLAN, 'roles', `${opName} forced while role ${roleId} is live in ${where}; the stale-stamp sweep must follow (A2)`);
        return false;
    }
    push(errors, CODES.E_ROLE_LIVE_IN_PLAN, 'roles', `refusing ${opName}: role ${roleId} is live in ${where} (pass force to override, then sweep stale stamps)`);
    return true;
}
/** Re-validate an op RESULT; on success recompute the hash and return it. */
function finishMutation(candidate, options, errors, warnings) {
    const checked = validateTeamManifest(candidate, options, { skipHashCheck: true });
    errors.push(...checked.errors);
    warnings.push(...checked.warnings);
    if (!checked.ok || checked.manifest === null) {
        return { ok: false, manifest: null, errors, warnings };
    }
    const next = checked.manifest;
    next.manifest_hash = computeHashOf(next);
    return { ok: true, manifest: next, errors, warnings };
}
/** Shared entry check: the op input must itself be a manifest-shaped mapping. */
function opInput(manifest, errors) {
    if (!isRecord(manifest) || !Array.isArray(manifest.roles)) {
        push(errors, CODES.E_BAD_MANIFEST, '', 'mutation input must be a parsed team manifest with a roles list');
        return null;
    }
    return manifest;
}
function roleIdOf(raw) {
    return isRecord(raw) && typeof raw.id === 'string' ? raw.id : '';
}
/**
 * PURE. Add a role. The RESULT is re-validated in full; an invalid result is
 * refused and the input manifest is never mutated (mutation discipline
 * adapted from ijfw, Sean Donahoe, internal).
 */
function addTeamRole(manifest, role, options) {
    const errors = [];
    const warnings = [];
    const opts = options ?? {};
    const doc = opInput(manifest, errors);
    if (doc === null)
        return { ok: false, manifest: null, errors, warnings };
    const id = roleIdOf(role);
    if (id !== '' && doc.roles.some((r) => roleIdOf(r) === id)) {
        push(errors, CODES.E_ROLE_EXISTS, 'roles', `role id ${id} already exists (swap it instead)`);
        return { ok: false, manifest: null, errors, warnings };
    }
    const candidate = { ...doc, roles: [...doc.roles, role] };
    return finishMutation(candidate, opts, errors, warnings);
}
/**
 * PURE. Remove a role by id. Refuses when the removal leaves the manifest
 * invalid (floor of 1 included) or when the role is live in a stamped plan
 * (A8; force downgrades that refusal to a warning).
 */
function removeTeamRole(manifest, roleId, options) {
    const errors = [];
    const warnings = [];
    const opts = options ?? {};
    const doc = opInput(manifest, errors);
    if (doc === null)
        return { ok: false, manifest: null, errors, warnings };
    const id = typeof roleId === 'string' ? roleId : '';
    const roles = doc.roles;
    if (!roles.some((r) => roleIdOf(r) === id)) {
        push(errors, CODES.E_ROLE_NOT_FOUND, 'roles', `no role with id ${JSON.stringify(roleId)}`);
        return { ok: false, manifest: null, errors, warnings };
    }
    if (planRefGuard(id, 'remove', opts, errors, warnings)) {
        return { ok: false, manifest: null, errors, warnings };
    }
    const candidate = { ...doc, roles: roles.filter((r) => roleIdOf(r) !== id) };
    return finishMutation(candidate, opts, errors, warnings);
}
/**
 * PURE. Replace the role holding `roleId` with `replacement`. A live plan
 * reference on the OUTGOING role refuses the swap (its inlined charter stamp
 * goes stale either way); force downgrades to a warning. The result is
 * re-validated in full and refused when invalid.
 */
function swapTeamRole(manifest, roleId, replacement, options) {
    const errors = [];
    const warnings = [];
    const opts = options ?? {};
    const doc = opInput(manifest, errors);
    if (doc === null)
        return { ok: false, manifest: null, errors, warnings };
    const id = typeof roleId === 'string' ? roleId : '';
    const roles = doc.roles;
    const idx = roles.findIndex((r) => roleIdOf(r) === id);
    if (idx === -1) {
        push(errors, CODES.E_ROLE_NOT_FOUND, 'roles', `no role with id ${JSON.stringify(roleId)}`);
        return { ok: false, manifest: null, errors, warnings };
    }
    const newId = roleIdOf(replacement);
    if (newId !== '' && newId !== id && roles.some((r) => roleIdOf(r) === newId)) {
        push(errors, CODES.E_ROLE_EXISTS, 'roles', `role id ${newId} already exists`);
        return { ok: false, manifest: null, errors, warnings };
    }
    if (planRefGuard(id, 'swap', opts, errors, warnings)) {
        return { ok: false, manifest: null, errors, warnings };
    }
    const nextRoles = roles.slice();
    nextRoles[idx] = replacement;
    const candidate = { ...doc, roles: nextRoles };
    return finishMutation(candidate, opts, errors, warnings);
}
// ---------- serializeTeamManifest ----------
/**
 * Emit the manifest block body in stable order (canonicalForm key order) with
 * manifest_hash recomputed, so serialize output is always self-consistent and
 * the hash is deterministic. With `markdown` holding exactly 1 closed team
 * block, only the block body is replaced and every surrounding prose byte is
 * preserved; an unusable markdown input comes back unchanged (the keeper
 * never damages a store it cannot parse). Without markdown, a fresh minimal
 * TEAM.md document is emitted.
 */
function serializeTeamManifest(manifest, markdown) {
    const checked = validateTeamManifest(manifest, undefined, { skipHashCheck: true });
    if (checked.manifest === null) {
        return typeof markdown === 'string' ? markdown : '';
    }
    const doc = canonicalForm(checked.manifest);
    const ordered = {
        schema: doc.schema,
        derived_from: doc.derived_from,
        manifest_hash: computeHashOf(checked.manifest),
        roles: doc.roles,
    };
    let dumped;
    try {
        dumped = yaml.dump(ordered, { lineWidth: 120, noRefs: true, sortKeys: false });
    }
    catch {
        return typeof markdown === 'string' ? markdown : '';
    }
    const innerLines = dumped.replace(/\n$/, '').split('\n');
    if (typeof markdown === 'string') {
        const lines = markdown.split('\n');
        const blocks = findTeamBlocks(lines);
        if (blocks.length !== 1 || blocks[0].closeIdx === -1)
            return markdown;
        const block = blocks[0];
        return [...lines.slice(0, block.openIdx + 1), ...innerLines, ...lines.slice(block.closeIdx)].join('\n');
    }
    return [
        '# TEAM',
        '',
        'The dynamic team roster (team-manifest/v1). Blessed at a brainstorm exit;',
        'mutate through the governed add/remove/swap ops, never by hand.',
        '',
        '```yaml team-manifest',
        ...innerLines,
        '```',
        '',
    ].join('\n');
}
module.exports = {
    parseTeamManifest,
    validateTeamManifest,
    computeTeamManifestHash,
    verifyTeamManifestHash,
    addTeamRole,
    removeTeamRole,
    swapTeamRole,
    serializeTeamManifest,
    globsOverlap,
    CODES,
    PARSE_CODES,
};
