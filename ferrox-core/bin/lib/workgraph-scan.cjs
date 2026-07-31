"use strict";
/**
 * workgraph-scan: the impure shell for the `workgraph/v1` document.
 *
 * IMPURE SHELL, PURE CORE, the same split `roadmap-index-scan.cts` uses. Every
 * disk read, every child process and every config resolution happens here, and
 * `workgraph.cjs` is handed plain records and plain path sets. That is what
 * keeps the pure core hermetic and its byte level tests meaningful.
 *
 * IT CONSUMES THE SHIPPED DERIVATIONS, it reimplements none of them:
 *   - the `phase-plan-index` verb for nodes, waves, declared edges, write lanes,
 *     task counts and the autonomous flag
 *   - `evaluateHotSeam` from `coord-hot-seam-check.cjs` for the hot seams
 *   - `evaluateSharedWrite` from `coord-shared-write-check.cjs` for the
 *     governance seams, and its anchored `globToRegExp` for role surfaces
 *   - `evaluateRiskGrade` from `model-risk-grade.cjs` for the risk grade
 *   - the `model.resolve-tier` verb for the model id behind a tier rung
 *   - `parseTeamManifest` from `team-manifest.cjs` for the roster
 *   - `loadConfig`, which already merges the manifest defaults for BOTH
 *     coordination lists and the whole model block, so nothing here writes a
 *     hand rolled fallback that could disagree with the shipped resolver
 *   - every parser, resolver, classifier and assembler in `workgraph.cjs`
 *
 * TWO REGISTRIES, NOT ONE. The phase context claimed the 4 governance files were
 * absent from this repository's model of shared surfaces. Read live, that is
 * narrower and more useful: `coordination.hot_seams` covers none of them, and
 * `coordination.shared_state_paths` covers STATE.md, ROADMAP.md and BACKLOG.md
 * in both their basename and planning-directory forms. The 2 registries answer
 * different questions, the parallel wave rule and the sole writer rule, and only
 * the first is what `coord.hot-seam-check` reads. So this module asks BOTH, and
 * a governance file neither one covers becomes a DERIVED seam gap. Derived, not
 * listed: a hardcoded roster of known-uncovered paths would be a claim rather
 * than a measurement and would rot in both directions.
 *
 * FAIL LOUD, NEVER FATAL ON A SINGLE FILE. An unreadable file or directory is
 * skipped and counted, a specifier that resolves to nothing reaches the emitted
 * document with its reason, and a resolved target outside the scan roots is
 * counted rather than turned into an edge. A graph that refuses to emit because
 * 1 file could not be opened is worse than a graph that says so. A CHILD
 * PROCESS failure is the other direction and is fatal: an empty graph caused by
 * a broken verb is indistinguishable from an empty phase.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/workgraph-scan.cjs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- workgraph.cjs is an export= CommonJS module
const workgraph = require("./workgraph.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- coord-hot-seam-check.cjs is an export= CommonJS module
const coordHotSeam = require("./coord-hot-seam-check.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- coord-shared-write-check.cjs is an export= CommonJS module
const coordSharedWrite = require("./coord-shared-write-check.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- model-risk-grade.cjs is an export= CommonJS module
const modelRiskGrade = require("./model-risk-grade.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- team-manifest.cjs is an export= CommonJS module
const teamManifest = require("./team-manifest.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- config-loader.cjs is an export= CommonJS module
const configLoader = require("./config-loader.cjs");
const { loadConfig } = configLoader;
const { evaluateHotSeam } = coordHotSeam;
const { evaluateSharedWrite, globToRegExp } = coordSharedWrite;
const { evaluateRiskGrade } = modelRiskGrade;
const { parseTeamManifest } = teamManifest;
// ─── the vocabulary ──────────────────────────────────────────────────────────
/** What the walk INDEXES, so a resolvable target is never a false miss. */
const DEFAULT_INDEX_ROOTS = ['src', 'scripts'];
/** What counts as IN SCOPE for an import edge and for an unbacked verdict. */
const DEFAULT_SCAN_ROOTS = ['src'];
/** File extensions the walk indexes. Everything else is not a module here. */
const INDEXED_EXTENSIONS = ['.cts', '.mts', '.ts', '.cjs', '.mjs', '.js'];
/** The 1 extension a cargo crate compiles. */
const RUST_EXTENSIONS = ['.rs'];
/**
 * What a cargo workspace actually lays out, read off a real 56 crate tree
 * rather than recalled: a root `src` for a single crate package, `crates` for
 * the near universal workspace member directory, and the 3 cargo target
 * directories that hold resolvable code without being subject matter.
 */
const RUST_INDEX_ROOTS = ['src', 'crates', 'examples', 'tests', 'benches'];
/**
 * What Rust counts as SUBJECT MATTER, the same split the JavaScript profile
 * draws between `src` and `scripts`: library and binary code is the graph's
 * business, and an example or a top level integration test is context that must
 * be indexed so its targets resolve but must not file its own unresolved rows.
 */
const RUST_SCAN_ROOTS = ['src', 'crates'];
/**
 * Directory names the walk never descends into.
 *
 * `target` is cargo's build directory and it holds a full second copy of every
 * dependency's source. Walking it would multiply the index by the dependency
 * count and manufacture edges into vendored code nobody in the phase writes.
 * This repository has no `src/target` or `scripts/target`, checked before the
 * name was added, so the JavaScript profile is untouched by it.
 */
const SKIPPED_DIRECTORIES = ['node_modules', '.git', 'target'];
/** The 2 registries this module asks about every governance surface. */
const HOT_SEAM_REGISTRY = 'coordination.hot_seams';
const SHARED_STATE_REGISTRY = 'coordination.shared_state_paths';
/** The 4 governance surfaces, held by basename so the gap is derived per file. */
const GOVERNANCE_SURFACES = ['BACKLOG.md', 'PROJECT.md', 'ROADMAP.md', 'STATE.md'];
/** The roster this repository does not ship, named once. */
const ROSTER_RELATIVE = '.planning/TEAM.md';
/** The stage whose tier every node in an execute phase is dispatched at. */
const EXECUTE_STAGE = 'execute';
/** A non-orchestrator actor, so the sole writer rule can actually answer. */
const NON_ORCHESTRATOR_ACTOR = 'executor';
/**
 * The single character wildcard. The team manifest validator admits it in an
 * owns or reviews surface, and the shipped anchored matcher escapes it and
 * matches it literally, so a glob carrying one is warned about rather than
 * silently read 2 ways.
 */
const SINGLE_CHAR_WILDCARD = '?';
/** The shipped CLI entrypoint, resolved from this module's own build location. */
const TOOLS_PATH = node_path_1.default.join(__dirname, '..', 'ferrox-tools.cjs');
// ─── the Rust vocabulary ─────────────────────────────────────────────────────
/** The 1 source suffix, held once so the resolver never spells it inline. */
const RUST_SUFFIX = '.rs';
/** The file that makes a directory a module, at any depth. */
const RUST_MOD_FILE = 'mod.rs';
/** The 2 stems that make a file a CRATE root, and only inside a crate's `src`. */
const RUST_CRATE_ROOT_STEMS = ['lib', 'main'];
/** The directory name every cargo crate compiles its roots out of. */
const RUST_SRC_DIRECTORY = 'src';
/** The 3 cargo directories whose immediate children are their own crate roots. */
const RUST_TARGET_DIRECTORIES = ['tests', 'examples', 'benches'];
/** The 3 path anchors that name a module INSIDE the current crate. */
const RUST_ANCHOR_CRATE = 'crate';
const RUST_ANCHOR_SUPER = 'super';
const RUST_ANCHOR_SELF = 'self';
/** The path separator in a Rust use tree. */
const RUST_PATH_SEPARATOR = '::';
/** The cargo manifest, and the section whose `name` is the crate's extern name. */
const CARGO_MANIFEST = 'Cargo.toml';
const CARGO_PACKAGE_SECTION = 'package';
/**
 * How many physical lines 1 `use` statement may span before the accumulator
 * gives up on finding its terminator. A `use` in the tree read for this work
 * spans at most 14; 64 is generous and it is a bound rather than a guess, so an
 * unterminated statement produced by a stray brace cannot swallow a whole file.
 */
const RUST_STATEMENT_LINE_BUDGET = 64;
/** The 3 edge forms Rust contributes, named in the emitted document. */
const RUST_FORM_MOD = 'mod';
const RUST_FORM_USE = 'use';
const RUST_FORM_EXTERN_CRATE = 'extern-crate';
// The declaration shapes. Anchored at the start of a comment-stripped line,
// because a `use` or a `mod` is a statement and never an expression fragment.
const RUST_VISIBILITY = String.raw `(?:pub\s*(?:\([^)]*\)\s*)?)?`;
const RUST_IDENT = String.raw `[A-Za-z_][A-Za-z0-9_]*`;
const RUST_MOD_SHAPE = new RegExp(`^\\s*${RUST_VISIBILITY}mod\\s+(${RUST_IDENT})\\s*([;{])`);
const RUST_USE_SHAPE = new RegExp(`^\\s*${RUST_VISIBILITY}use\\s+(.*)$`);
const RUST_EXTERN_CRATE_SHAPE = new RegExp(`^\\s*${RUST_VISIBILITY}extern\\s+crate\\s+(${RUST_IDENT})`);
const RUST_PATH_ATTRIBUTE_SHAPE = /^\s*#\s*!?\[\s*path\s*=\s*"([^"]*)"\s*\]\s*$/;
const RUST_ATTRIBUTE_SHAPE = /^\s*#\s*!?\[/;
const RUST_CHAR_LITERAL_SHAPE = /^'(?:\\.|[^\\'])'/;
const CARGO_SECTION_SHAPE = /^\s*\[\s*([^\]]*?)\s*\]\s*$/;
const CARGO_NAME_SHAPE = /^\s*name\s*=\s*"([^"]*)"/;
// ─── small shared helpers ────────────────────────────────────────────────────
function asStringArray(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}
function compareStrings(a, b) {
    if (a < b)
        return -1;
    if (a > b)
        return 1;
    return 0;
}
function basenameOf(filePath) {
    const cut = filePath.lastIndexOf('/');
    return cut === -1 ? filePath : filePath.slice(cut + 1);
}
function hasExtension(name, extensions) {
    for (const ext of extensions) {
        if (name.endsWith(ext))
            return true;
    }
    return false;
}
function isRustFile(filePath) {
    return filePath.endsWith(RUST_SUFFIX);
}
/** Unique, order preserving, empties dropped. */
function uniqueStrings(values) {
    const out = [];
    for (const value of values) {
        if (value !== '' && !out.includes(value))
            out.push(value);
    }
    return out;
}
function dirOf(filePath) {
    const cut = filePath.lastIndexOf('/');
    return cut === -1 ? '' : filePath.slice(0, cut);
}
function joinPath(base, child) {
    return workgraph.normalizePath(base === '' ? child : base + '/' + child);
}
// ─── the language profiles ───────────────────────────────────────────────────
/**
 * The 2 languages this scan can read, each with the layout its toolchain uses.
 *
 * The JavaScript profile reuses the exported default constants verbatim, so a
 * repository that ships only a `package.json` indexes and scans exactly what it
 * did before any of this existed. That equality is the regression fence.
 */
const LANGUAGE_PROFILES = [
    {
        id: 'js',
        marker: 'package.json',
        extensions: INDEXED_EXTENSIONS,
        indexRoots: DEFAULT_INDEX_ROOTS,
        scanRoots: DEFAULT_SCAN_ROOTS,
    },
    {
        id: 'rust',
        marker: CARGO_MANIFEST,
        extensions: RUST_EXTENSIONS,
        indexRoots: RUST_INDEX_ROOTS,
        scanRoots: RUST_SCAN_ROOTS,
    },
];
/**
 * Every profile whose marker manifest sits at the repository root.
 *
 * A polyglot tree turns BOTH on and the roots and extensions union, because a
 * repository holding a `package.json` and a `Cargo.toml` really does hold both
 * languages and picking 1 would silently drop the other's edges. A tree with no
 * marker at all falls back to the JavaScript profile, which is what every
 * scratch tree in the existing test suite is and what keeps them unchanged.
 */
function detectLanguages(cwd) {
    const active = [];
    for (const profile of LANGUAGE_PROFILES) {
        let present = false;
        try {
            present = node_fs_1.default.statSync(node_path_1.default.join(cwd, profile.marker)).isFile();
        }
        catch {
            present = false;
        }
        if (present)
            active.push(profile);
    }
    return active.length > 0 ? active : [LANGUAGE_PROFILES[0]];
}
/**
 * Split a DEFAULTED root list into the directories that exist and those that
 * do not, so a conventional root the tree simply does not use is reported as
 * absent rather than warned about as unreadable.
 *
 * Only the defaults are filtered. A root the caller asked for BY NAME is passed
 * through untouched, because a caller that names a directory that is not there
 * has made a mistake the walk should still report.
 */
function resolveDefaultRoots(cwd, roots) {
    const present = [];
    const absent = [];
    for (const raw of uniqueStrings(roots.map((r) => workgraph.normalizePath(r)))) {
        let there = false;
        try {
            there = node_fs_1.default.statSync(node_path_1.default.join(cwd, ...raw.split('/'))).isDirectory();
        }
        catch {
            there = false;
        }
        if (there)
            present.push(raw);
        else
            absent.push(raw);
    }
    return { present, absent };
}
/** The default child runner: a real spawn of the shipped CLI. */
function spawnTools(args, cwd) {
    const result = (0, node_child_process_1.spawnSync)(process.execPath, [TOOLS_PATH, ...args, '--cwd', cwd], {
        encoding: 'utf8',
    });
    return {
        status: typeof result.status === 'number' ? result.status : 1,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : String(result.error || ''),
    };
}
// ─── the walk ────────────────────────────────────────────────────────────────
/**
 * Every indexed source file under the index roots, as repository relative
 * forward slash paths, sorted.
 *
 * The index roots are deliberately WIDER than the scan roots. A file under
 * `src/` that imports a module under `scripts/` really does resolve, and an
 * index that could not see it would report a false `no-file-resolves` miss,
 * which reads exactly like a broken import. Indexing it and then declining to
 * emit an edge for it is the honest answer, and it is what the out of root
 * counter records.
 *
 * The extension list is a parameter with the JavaScript set as its default, so
 * an existing 2 argument call indexes exactly the 6 extensions it always did.
 */
function walkSourceFiles(root, indexRoots, extensions) {
    const roots = asStringArray(indexRoots).length > 0
        ? asStringArray(indexRoots)
        : DEFAULT_INDEX_ROOTS;
    const indexed = asStringArray(extensions).length > 0
        ? asStringArray(extensions)
        : INDEXED_EXTENSIONS;
    const files = [];
    const unreadable = [];
    const descend = (relative) => {
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(node_path_1.default.join(root, ...relative.split('/')), { withFileTypes: true });
        }
        catch {
            unreadable.push(relative);
            return;
        }
        for (const entry of entries) {
            if (SKIPPED_DIRECTORIES.includes(entry.name))
                continue;
            const child = `${relative}/${entry.name}`;
            if (entry.isDirectory()) {
                descend(child);
                continue;
            }
            if (!entry.isFile())
                continue;
            if (hasExtension(entry.name, indexed))
                files.push(child);
        }
    };
    for (const raw of roots) {
        const rootRelative = workgraph.normalizePath(raw);
        if (rootRelative === '')
            continue;
        descend(rootRelative);
    }
    return { files: files.slice().sort(compareStrings), unreadable };
}
/**
 * Parse every file INSIDE THE SCAN ROOTS and resolve every specifier against the
 * whole index the walk collected, so resolution never touches a disk.
 *
 * The 2 sets differ on purpose. The scan speaks only about the scan roots, so a
 * module under any other index root is read as context rather than as subject
 * matter: its own imports are none of this graph's business, and reporting them
 * would bury the phase's own unresolved specifiers under hundreds of rows about
 * files no plan in the phase names. Indexing it anyway is what turns a target
 * outside the scan roots into an OUT OF ROOT count rather than a false
 * `no-file-resolves` miss, which reads exactly like a broken import.
 *
 * An unreadable file is skipped and counted rather than thrown. A dynamic
 * require carries no specifier and is neither an edge nor a miss, because it is
 * not a module id at all.
 *
 * THE LANGUAGE IS READ OFF THE FILE, not off a parameter. A `.rs` file goes to
 * the Rust reader and everything else to the JavaScript one, so a polyglot tree
 * needs no switch and a tree with 1 language pays for 1. The crate index is
 * derived from the file list, so a Rust tree resolves without a disk read here.
 */
function scanImports(input) {
    const root = typeof input.root === 'string' ? input.root : '';
    const files = asStringArray(input.files);
    const scanRoots = asStringArray(input.scanRoots).length > 0
        ? asStringArray(input.scanRoots)
        : DEFAULT_SCAN_ROOTS;
    const existing = new Set(files);
    const crates = deriveRustCrates(files, input.crateNames);
    const importEdges = [];
    const unresolved = [];
    const unreadable = [];
    let external = 0;
    let outOfRoot = 0;
    let read = 0;
    for (const filePath of files) {
        if (!workgraph.isInScanRoot(filePath, scanRoots))
            continue;
        let text;
        try {
            text = node_fs_1.default.readFileSync(node_path_1.default.join(root, ...filePath.split('/')), 'utf8');
        }
        catch {
            unreadable.push(filePath);
            continue;
        }
        read += 1;
        if (isRustFile(filePath)) {
            const scanned = scanRustFile({ filePath, text, indexed: existing, crates });
            external += scanned.external;
            for (const miss of scanned.unresolved)
                unresolved.push(miss);
            for (const edge of scanned.edges) {
                if (!workgraph.isInScanRoot(edge.to, scanRoots)) {
                    outOfRoot += 1;
                    continue;
                }
                importEdges.push(edge);
            }
            continue;
        }
        for (const spec of workgraph.parseImportSources(text, filePath).results) {
            if (spec.dynamic)
                continue;
            if (spec.external) {
                external += 1;
                continue;
            }
            const resolved = workgraph.resolveSpecifier(filePath, spec.specifier, existing, scanRoots);
            if (!resolved.ok) {
                unresolved.push({ from: filePath, specifier: spec.specifier, reason: resolved.reason });
                continue;
            }
            if (!resolved.in_scan_root) {
                outOfRoot += 1;
                continue;
            }
            if (resolved.path === filePath)
                continue;
            importEdges.push({
                from: filePath,
                to: resolved.path,
                form: spec.form,
                type_only: spec.type_only,
            });
        }
    }
    return {
        import_edges: importEdges,
        unresolved,
        counts: { files: read, edges: importEdges.length, external, out_of_root: outOfRoot },
        unreadable,
    };
}
/**
 * The code half of 1 Rust line, comments removed and string literals PRESERVED,
 * carrying block, quote and raw string state across the call.
 *
 * The state is the whole point and it is load bearing in both directions. A
 * Rust doc comment routinely carries a `use` line as an example, and a scanner
 * reading lines in isolation manufactures an import edge out of prose. That is
 * a false edge. The other direction is worse and quieter: a string literal
 * holding an unterminated block comment opener would swallow the rest of the
 * file and every real import in it would silently disappear.
 *
 * A string literal that OPENS AND CLOSES on 1 line survives verbatim, because
 * `#[path = "..."]` is read off this output. The CONTINUATION of a string that
 * was already open when the line began contributes nothing, and that asymmetry
 * is load bearing rather than tidy: a crate that parses Rust holds Rust source
 * inside multi line string fixtures, and treating a fixture's `mod private;` as
 * a declaration files a miss against a module that was never declared. Measured
 * on a real workspace that is 2 of 7 remaining misses, and a miss that is not
 * real is the same dishonesty as an edge that is not real.
 *
 * Block comments NEST in Rust, so the depth is counted rather than flagged. The
 * net brace count of the line is carried out too, with string and comment
 * braces excluded, so an inline module's body can be delimited without a
 * second pass that would have to repeat all of this.
 */
function stripRustLine(line, state) {
    let out = '';
    let i = 0;
    state.braceDelta = 0;
    // True only while inside the string this line INHERITED. It clears the moment
    // that string closes, so code sharing a line with the closing delimiter is
    // still read. Suppressing to the end of the line instead would drop a real
    // declaration for the sake of a fixture, which is the same defect the other
    // way round.
    let carried = state.inQuote || state.rawHashes >= 0;
    while (i < line.length) {
        if (state.rawHashes >= 0) {
            const close = '"' + '#'.repeat(state.rawHashes);
            const at = line.indexOf(close, i);
            if (at === -1) {
                if (!carried)
                    out += line.slice(i);
                return out;
            }
            if (!carried)
                out += line.slice(i, at + close.length);
            state.rawHashes = -1;
            carried = false;
            i = at + close.length;
            continue;
        }
        if (state.inQuote) {
            const ch = line.charAt(i);
            if (!carried)
                out += ch;
            if (ch === '\\' && i + 1 < line.length) {
                if (!carried)
                    out += line.charAt(i + 1);
                i += 2;
                continue;
            }
            if (ch === '"') {
                state.inQuote = false;
                carried = false;
            }
            i += 1;
            continue;
        }
        const two = line.slice(i, i + 2);
        if (state.blockDepth > 0) {
            if (two === '/*') {
                state.blockDepth += 1;
                i += 2;
                continue;
            }
            if (two === '*/') {
                state.blockDepth -= 1;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if (two === '//')
            return out;
        if (two === '/*') {
            state.blockDepth = 1;
            i += 2;
            continue;
        }
        const rawOpen = /^(?:b?r)(#*)"/.exec(line.slice(i));
        if (rawOpen !== null) {
            state.rawHashes = rawOpen[1].length;
            out += rawOpen[0];
            i += rawOpen[0].length;
            continue;
        }
        const ch = line.charAt(i);
        if (ch === '"') {
            state.inQuote = true;
            out += ch;
            i += 1;
            continue;
        }
        if (ch === '{')
            state.braceDelta += 1;
        if (ch === '}')
            state.braceDelta -= 1;
        // A character literal, recognized ONLY in its complete shape. A lifetime
        // (`&'a str`) opens with the same character and must not be read as one,
        // and a character literal holding a quote (`'"'`) must not open a string.
        if (ch === "'") {
            const literal = RUST_CHAR_LITERAL_SHAPE.exec(line.slice(i));
            if (literal !== null) {
                out += literal[0];
                i += literal[0].length;
                continue;
            }
        }
        out += ch;
        i += 1;
    }
    return out;
}
/**
 * Split 1 `use` tree into its leaf paths, 1 segment array per leaf.
 *
 * `use a::b;` yields `[[a, b]]`. `use a::{b, c::d};` yields `[[a,b],[a,c,d]]`.
 * `use a::{self, b};` yields `[[a],[a,b]]`, because `self` inside a group names
 * the group's own prefix. An `as` alias and a `*` glob are dropped: neither
 * names a file, and the prefix in front of them is what the edge is about.
 */
function expandRustUseTree(tree, prefix) {
    const text = tree.trim();
    if (text === '')
        return [];
    let depth = 0;
    let open = -1;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        if (ch === '{') {
            if (depth === 0)
                open = i;
            depth += 1;
            continue;
        }
        if (ch === '}')
            depth -= 1;
    }
    if (open === -1) {
        const segments = [];
        for (const raw of text.split(RUST_PATH_SEPARATOR)) {
            const segment = raw.trim().split(/\s+as\s+/)[0].trim();
            if (segment === '' || segment === '*')
                continue;
            if (segment === RUST_ANCHOR_SELF && segments.length > 0)
                continue;
            segments.push(segment);
        }
        return segments.length === 0 && prefix.length === 0 ? [] : [prefix.concat(segments)];
    }
    // Everything before the group is a literal prefix; everything inside it is a
    // comma separated list of subtrees carrying that prefix.
    const head = expandRustUseTree(text.slice(0, open).replace(/::\s*$/, ''), prefix);
    const carried = head.length > 0 ? head[0] : prefix;
    let close = -1;
    let level = 0;
    for (let i = open; i < text.length; i++) {
        const ch = text.charAt(i);
        if (ch === '{')
            level += 1;
        else if (ch === '}') {
            level -= 1;
            if (level === 0) {
                close = i;
                break;
            }
        }
    }
    const inner = close === -1 ? text.slice(open + 1) : text.slice(open + 1, close);
    const members = [];
    let member = '';
    let group = 0;
    for (const ch of inner) {
        if (ch === '{')
            group += 1;
        if (ch === '}')
            group -= 1;
        if (ch === ',' && group === 0) {
            members.push(member);
            member = '';
            continue;
        }
        member += ch;
    }
    members.push(member);
    const out = [];
    for (const raw of members) {
        const trimmed = raw.trim();
        if (trimmed === '')
            continue;
        if (trimmed === RUST_ANCHOR_SELF) {
            out.push(carried.slice());
            continue;
        }
        for (const leaf of expandRustUseTree(trimmed, carried))
            out.push(leaf);
    }
    return out;
}
/**
 * Every declaration in 1 Rust source file that could name a second file.
 *
 * A `use` is accumulated across physical lines until its terminating semicolon,
 * because 623 of the 4918 `use` statements in the tree this rule was read
 * against span more than 1 line and a line at a time reader would see none of
 * them. The accumulation is BOUNDED: an unterminated statement gives up rather
 * than consuming the file.
 *
 * A `#[path = "..."]` attribute is carried forward across any further attribute
 * lines, because a `#[cfg(...)]` routinely sits between it and its `mod`. It is
 * dropped the moment a line that is neither an attribute nor a `mod` appears,
 * so it can never attach to a declaration it does not belong to.
 *
 * An INLINE module opens a scope, and a `mod` inside one looks for its file
 * under a directory named after that inline module. Tracking it is what stops
 * `mod windows_impl { mod command; }` filing a miss against
 * `backends/appcontainer/command.rs`, which is not where the file is, instead
 * of an edge to `backends/appcontainer/windows_impl/command.rs`, which is.
 */
function parseRustDeclarations(text) {
    const out = [];
    if (typeof text !== 'string' || text === '')
        return out;
    const state = { blockDepth: 0, inQuote: false, rawHashes: -1, braceDelta: 0 };
    const lines = [];
    const deltas = [];
    for (const line of workgraph.splitLines(text)) {
        lines.push(stripRustLine(line, state));
        deltas.push(state.braceDelta);
    }
    let pathAttribute = '';
    let depth = 0;
    const inlineScope = [];
    const scopeNames = () => inlineScope.map((entry) => entry.name);
    for (let i = 0; i < lines.length; i++) {
        const code = lines[i];
        const enteredAt = depth;
        depth += deltas[i];
        while (inlineScope.length > 0 && depth < inlineScope[inlineScope.length - 1].bodyDepth) {
            inlineScope.pop();
        }
        if (code.trim() === '')
            continue;
        const lineNo = i + 1;
        const attribute = RUST_PATH_ATTRIBUTE_SHAPE.exec(code);
        if (attribute !== null) {
            pathAttribute = attribute[1];
            continue;
        }
        const declaredMod = RUST_MOD_SHAPE.exec(code);
        if (declaredMod !== null) {
            // A brace opens an INLINE module. It declares no second file, so it is
            // not an edge, but it does open a scope every `mod` inside it resolves
            // through. Its path attribute is spent either way.
            if (declaredMod[2] === ';') {
                out.push({
                    form: RUST_FORM_MOD,
                    name: declaredMod[1],
                    paths: [],
                    pathAttribute,
                    scope: scopeNames(),
                    line: lineNo,
                });
            }
            else {
                inlineScope.push({ name: declaredMod[1], bodyDepth: enteredAt + 1 });
            }
            pathAttribute = '';
            continue;
        }
        const externCrate = RUST_EXTERN_CRATE_SHAPE.exec(code);
        if (externCrate !== null) {
            out.push({
                form: RUST_FORM_EXTERN_CRATE,
                name: externCrate[1],
                paths: [],
                pathAttribute: '',
                scope: scopeNames(),
                line: lineNo,
            });
            pathAttribute = '';
            continue;
        }
        const use = RUST_USE_SHAPE.exec(code);
        if (use !== null) {
            let statement = use[1];
            let consumed = 0;
            while (!statement.includes(';') && consumed < RUST_STATEMENT_LINE_BUDGET && i + 1 < lines.length) {
                i += 1;
                consumed += 1;
                depth += deltas[i];
                statement += ' ' + lines[i];
            }
            const terminator = statement.indexOf(';');
            if (terminator !== -1) {
                out.push({
                    form: RUST_FORM_USE,
                    name: '',
                    paths: expandRustUseTree(statement.slice(0, terminator), []),
                    pathAttribute: '',
                    scope: scopeNames(),
                    line: lineNo,
                });
            }
            pathAttribute = '';
            continue;
        }
        if (!RUST_ATTRIBUTE_SHAPE.test(code))
            pathAttribute = '';
    }
    return out;
}
// ─── the Rust crate index and resolver ───────────────────────────────────────
/**
 * Every crate the indexed file list reveals, keyed both by depth and by the
 * identifier a sibling crate writes.
 *
 * A crate is a directory holding `src/lib.rs` or `src/main.rs`. That is derived
 * from the tree rather than read out of a workspace member list, so a crate the
 * member list forgot is still found and a member entry pointing at nothing
 * still contributes nothing. The extern name is the crate's declared package
 * name where the caller supplied one, and the directory basename otherwise;
 * cargo reads a hyphen in either as an underscore, so both are mangled the same
 * way. Measured against a real 56 crate workspace, the 2 agree on all 56.
 */
function deriveRustCrates(files, crateNames) {
    const names = crateNames === null || typeof crateNames !== 'object' ? {} : crateNames;
    const indexed = new Set(files);
    const byDir = new Map();
    for (const filePath of files) {
        if (!isRustFile(filePath))
            continue;
        const srcDir = dirOf(filePath);
        if (basenameOf(srcDir) !== RUST_SRC_DIRECTORY)
            continue;
        const stem = basenameOf(filePath).slice(0, -RUST_SUFFIX.length);
        if (!RUST_CRATE_ROOT_STEMS.includes(stem))
            continue;
        const dir = dirOf(srcDir);
        const held = byDir.get(dir);
        // `lib.rs` outranks `main.rs`: a crate shipping both is a library with a
        // binary front end, and a sibling `use` names the library.
        if (held !== undefined && basenameOf(held.rootFile) !== 'main' + RUST_SUFFIX)
            continue;
        const declared = typeof names[dir] === 'string' ? names[dir] : '';
        const fallback = dir === '' ? '' : basenameOf(dir);
        const externName = (declared !== '' ? declared : fallback).replace(/-/g, '_');
        byDir.set(dir, { dir, srcDir, rootFile: filePath, externName });
    }
    // The immediate children of `tests`, `examples` and `benches` are each their
    // own crate root: cargo compiles every one as a separate binary, so `crate::`
    // inside one of them anchors at that file and not at the library beside it.
    // A DIRECTORY child roots at its `main.rs` where cargo auto discovers one and
    // at its `mod.rs` otherwise, which is what a `[[test]] path` entry points at
    // and is the module root convention everywhere else in the language. Without
    // it every file under such a directory has no anchor at all and its whole
    // `crate::` surface reads as unresolvable.
    for (const filePath of files) {
        if (!isRustFile(filePath))
            continue;
        const parent = dirOf(filePath);
        const kind = basenameOf(parent);
        const name = basenameOf(filePath);
        const stem = name.slice(0, -RUST_SUFFIX.length);
        let root = '';
        let anchor = '';
        if (RUST_TARGET_DIRECTORIES.includes(kind)) {
            root = filePath;
            anchor = joinPath(parent, stem);
        }
        else if ((stem === 'main' || name === RUST_MOD_FILE)
            && RUST_TARGET_DIRECTORIES.includes(basenameOf(dirOf(parent)))) {
            root = filePath;
            anchor = parent;
        }
        if (root === '' || !indexed.has(root))
            continue;
        const held = byDir.get(anchor);
        // `main.rs` outranks `mod.rs`: where both exist cargo compiles the first.
        if (held !== undefined && basenameOf(held.rootFile) !== RUST_MOD_FILE)
            continue;
        byDir.set(anchor, { dir: anchor, srcDir: anchor, rootFile: root, externName: '' });
    }
    const byDepth = Array.from(byDir.values()).sort((a, b) => b.srcDir.length - a.srcDir.length || compareStrings(a.srcDir, b.srcDir));
    const byExternName = new Map();
    for (const record of byDepth) {
        if (record.externName === '' || byExternName.has(record.externName))
            continue;
        byExternName.set(record.externName, record.rootFile);
    }
    return { byDepth, byExternName };
}
/** The crate a file belongs to: the deepest crate whose source directory holds it. */
function crateOf(filePath, crates) {
    for (const record of crates.byDepth) {
        if (filePath === record.rootFile)
            return record;
        if (record.srcDir === '' || filePath.startsWith(record.srcDir + '/'))
            return record;
    }
    return null;
}
/**
 * The directory a `mod NAME;` inside this file looks for `NAME` in.
 *
 * The Rust 2018 rule, stated: a crate root and a `mod.rs` anchor at their own
 * directory, and every other file anchors at a directory named after itself. So
 * `mod bar;` in `src/lib.rs` is `src/bar.rs`, and the same line in `src/foo.rs`
 * is `src/foo/bar.rs`.
 */
function rustModuleDir(filePath, crates) {
    const dir = dirOf(filePath);
    const name = basenameOf(filePath);
    if (name === RUST_MOD_FILE)
        return dir;
    const record = crateOf(filePath, crates);
    if (record !== null && record.rootFile === filePath)
        return dir;
    return joinPath(dir, name.slice(0, -RUST_SUFFIX.length));
}
/** The file a module directory's own module is written in, when one is indexed. */
function rustModuleFile(moduleDir, indexed) {
    const asFile = moduleDir + RUST_SUFFIX;
    if (indexed.has(asFile))
        return asFile;
    const asDir = joinPath(moduleDir, RUST_MOD_FILE);
    if (indexed.has(asDir))
        return asDir;
    return '';
}
/** The 1 module file a name resolves to inside a directory, or the empty string. */
function resolveRustModule(moduleDir, name, indexed) {
    return rustModuleFile(joinPath(moduleDir, name), indexed);
}
/**
 * The longest prefix of a leaf path that resolves to an indexed module file.
 *
 * Greedy and first hit wins, the same discipline `resolveSpecifier` keeps: a
 * resolver that gathers every candidate and picks a winner afterwards has 2
 * places to be wrong instead of 1. When no segment resolves the anchor's own
 * file is the answer, because the item named must be defined or re-exported
 * there.
 */
function resolveRustPath(input) {
    let dir = input.anchorDir;
    let best = input.anchorFile;
    for (const segment of input.segments) {
        const hit = resolveRustModule(dir, segment, input.indexed);
        if (hit === '')
            break;
        best = hit;
        dir = joinPath(dir, segment);
    }
    return best;
}
/**
 * Every edge 1 Rust file contributes, plus what it could not resolve and what
 * it read as belonging to another package.
 *
 * A target that resolves to nothing is RECORDED with the specifier that named
 * it, never dropped: a `#[cfg]` gated module whose file is not in the tree is a
 * real fact about this checkout, and a scan that swallowed it would report a
 * smaller graph as though it were a complete one.
 */
function scanRustFile(input) {
    const { filePath, indexed, crates } = input;
    const edges = [];
    const unresolved = [];
    let external = 0;
    const own = crateOf(filePath, crates);
    const fileModuleDir = rustModuleDir(filePath, crates);
    const fileParentDir = basenameOf(filePath) === RUST_MOD_FILE
        ? dirOf(dirOf(filePath))
        : dirOf(filePath);
    const record = (target, form) => {
        if (target === '' || target === filePath)
            return;
        edges.push({ from: filePath, to: target, form, type_only: false });
    };
    for (const declaration of parseRustDeclarations(input.text)) {
        // Every inline module the declaration sits inside adds a directory level,
        // so a declaration at the top of the file resolves exactly as before.
        const scope = declaration.scope;
        const moduleDir = scope.length === 0 ? fileModuleDir : joinPath(fileModuleDir, scope.join('/'));
        const parentDir = scope.length === 0
            ? fileParentDir
            : joinPath(fileModuleDir, scope.slice(0, -1).join('/'));
        if (declaration.form === RUST_FORM_MOD) {
            const specifier = declaration.pathAttribute !== ''
                ? declaration.pathAttribute
                : declaration.name;
            const target = declaration.pathAttribute !== ''
                // A path attribute on a top level `mod` is relative to the DIRECTORY of
                // the file carrying it, which is not the same as the module directory
                // for any file that is not a crate root or a `mod.rs`.
                ? joinPath(scope.length === 0 ? dirOf(filePath) : moduleDir, declaration.pathAttribute)
                : resolveRustModule(moduleDir, declaration.name, indexed);
            if (target === '' || !indexed.has(target)) {
                unresolved.push({ from: filePath, specifier, reason: 'no-file-resolves' });
                continue;
            }
            record(target, RUST_FORM_MOD);
            continue;
        }
        if (declaration.form === RUST_FORM_EXTERN_CRATE) {
            const rootFile = crates.byExternName.get(declaration.name);
            if (rootFile === undefined) {
                external += 1;
                continue;
            }
            record(rootFile, RUST_FORM_EXTERN_CRATE);
            continue;
        }
        for (const segments of declaration.paths) {
            if (segments.length === 0)
                continue;
            const head = segments[0];
            const rest = segments.slice(1);
            if (head === RUST_ANCHOR_CRATE) {
                if (own === null) {
                    unresolved.push({
                        from: filePath,
                        specifier: segments.join(RUST_PATH_SEPARATOR),
                        reason: 'no-file-resolves',
                    });
                    continue;
                }
                record(resolveRustPath({ anchorDir: own.srcDir, anchorFile: own.rootFile, segments: rest, indexed }), RUST_FORM_USE);
                continue;
            }
            if (head === RUST_ANCHOR_SUPER) {
                // Every further leading `super` walks 1 more module up.
                let dir = parentDir;
                let remaining = rest;
                while (remaining.length > 0 && remaining[0] === RUST_ANCHOR_SUPER) {
                    dir = dirOf(dir);
                    remaining = remaining.slice(1);
                }
                record(resolveRustPath({
                    anchorDir: dir,
                    anchorFile: rustModuleFile(dir, indexed),
                    segments: remaining,
                    indexed,
                }), RUST_FORM_USE);
                continue;
            }
            if (head === RUST_ANCHOR_SELF) {
                record(resolveRustPath({ anchorDir: moduleDir, anchorFile: filePath, segments: rest, indexed }), RUST_FORM_USE);
                continue;
            }
            const rootFile = crates.byExternName.get(head);
            if (rootFile !== undefined) {
                const sibling = crateOf(rootFile, crates);
                record(resolveRustPath({
                    anchorDir: sibling === null ? dirOf(rootFile) : sibling.srcDir,
                    anchorFile: rootFile,
                    segments: rest,
                    indexed,
                }), RUST_FORM_USE);
                continue;
            }
            // UNIFORM PATHS, stabilized in the 2018 edition: a bare head segment may
            // also name a module of the CURRENT module rather than another package.
            // Measured on a real 56 crate workspace, 378 `use` statements resolve
            // this way, so reading every bare head as external would silently drop
            // 378 intra-crate edges. The crate index is asked first because a name
            // that is both would be ambiguous to rustc as well.
            const local = resolveRustModule(moduleDir, head, indexed);
            if (local === '') {
                external += 1;
                continue;
            }
            record(resolveRustPath({
                anchorDir: joinPath(moduleDir, head),
                anchorFile: local,
                segments: rest,
                indexed,
            }), RUST_FORM_USE);
        }
    }
    return { edges, unresolved, external };
}
// ─── the plan index read ─────────────────────────────────────────────────────
/**
 * The shipped `phase-plan-index` verb, read as a child process.
 *
 * A non-zero exit surfaces the child's stderr with a named fix rather than a
 * parse failure, and a phase with no directory is reported as absent rather
 * than as an empty plan list. An empty graph for a phase that does not exist is
 * indistinguishable from an empty graph for a phase nobody has planned yet, and
 * only 1 of those is a mistake.
 */
function readPlanIndex(input) {
    const cwd = typeof input.cwd === 'string' ? input.cwd : '';
    const phase = typeof input.phase === 'string' ? input.phase : '';
    const runner = typeof input.runner === 'function' ? input.runner : spawnTools;
    const empty = { ok: false, phase, plans: [], warnings: [], message: '' };
    const result = runner(['phase-plan-index', phase, '--raw'], cwd);
    if (result.status !== 0) {
        return Object.assign({}, empty, {
            message: `the phase-plan-index verb exited ${result.status} for phase ${phase}:\n`
                + `${result.stderr.trim()}\nFix: run the verb by hand and repair what it names:\n`
                + `  node ferrox-core/bin/ferrox-tools.cjs phase-plan-index ${phase} --cwd ${cwd}`,
        });
    }
    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    }
    catch {
        return Object.assign({}, empty, {
            message: `the phase-plan-index verb printed output that is not JSON for phase ${phase}.\n`
                + 'Fix: run the verb by hand and read what it printed:\n'
                + `  node ferrox-core/bin/ferrox-tools.cjs phase-plan-index ${phase} --cwd ${cwd}`,
        });
    }
    if (typeof parsed.error === 'string' && parsed.error !== '') {
        return Object.assign({}, empty, {
            message: `phase ${phase} has no phase directory, so there is no graph to emit (${parsed.error}).\n`
                + 'Fix: name a phase that exists, which you can list with:\n'
                + '  node ferrox-core/bin/ferrox-tools.cjs phase list',
        });
    }
    const plans = Array.isArray(parsed.plans) ? parsed.plans : [];
    return {
        ok: true,
        phase: typeof parsed.phase === 'string' ? parsed.phase : phase,
        plans,
        warnings: asStringArray(parsed.warnings),
        message: '',
    };
}
// ─── the tier read ───────────────────────────────────────────────────────────
/**
 * The model id behind 1 tier rung, from the shipped `model.resolve-tier` verb.
 *
 * The caller memoizes per distinct rung, so a phase with many nodes spawns at
 * most 1 process per rung. A miss is carried through rather than hidden: a null
 * model id with a named reason is the honest answer for a repository that
 * configures no ladder.
 */
function resolveTierModel(input) {
    const runner = typeof input.runner === 'function' ? input.runner : spawnTools;
    const result = runner(['query', 'model.resolve-tier', '--tier', input.tier, '--raw'], input.cwd);
    if (result.status !== 0) {
        return { model_id: null, ladder_miss: `resolve-tier exited ${result.status}` };
    }
    try {
        const parsed = JSON.parse(result.stdout);
        const modelId = typeof parsed.modelId === 'string' ? parsed.modelId : null;
        const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
        return { model_id: modelId, ladder_miss: modelId === null ? reason : '' };
    }
    catch {
        return { model_id: null, ladder_miss: 'resolve-tier printed output that is not JSON' };
    }
}
// ─── the cargo manifest read ─────────────────────────────────────────────────
/**
 * The package name each crate directory declares, read off its own manifest.
 *
 * The directory basename is a good enough fallback and it agrees with the
 * declared name on all 56 crates of the workspace this rule was measured
 * against. It is a fallback rather than the answer because cargo does NOT
 * require the 2 to agree, and a crate that renames itself would otherwise
 * become invisible to every sibling that names it.
 *
 * The read is section aware: `name` means the package's name only inside
 * `[package]`, and a `name` key under any other table is a different fact.
 */
function readCrateNames(cwd, files) {
    const names = {};
    const dirs = [];
    for (const filePath of files) {
        if (!isRustFile(filePath))
            continue;
        const srcDir = dirOf(filePath);
        if (basenameOf(srcDir) !== RUST_SRC_DIRECTORY)
            continue;
        const stem = basenameOf(filePath).slice(0, -RUST_SUFFIX.length);
        if (!RUST_CRATE_ROOT_STEMS.includes(stem))
            continue;
        const dir = dirOf(srcDir);
        if (!dirs.includes(dir))
            dirs.push(dir);
    }
    for (const dir of dirs) {
        const manifest = dir === '' ? [CARGO_MANIFEST] : dir.split('/').concat(CARGO_MANIFEST);
        let text;
        try {
            text = node_fs_1.default.readFileSync(node_path_1.default.join(cwd, ...manifest), 'utf8');
        }
        catch {
            continue;
        }
        let section = '';
        for (const line of workgraph.splitLines(text)) {
            const heading = CARGO_SECTION_SHAPE.exec(line);
            if (heading !== null) {
                section = heading[1];
                continue;
            }
            if (section !== CARGO_PACKAGE_SECTION)
                continue;
            const name = CARGO_NAME_SHAPE.exec(line);
            if (name !== null) {
                names[dir] = name[1];
                break;
            }
        }
    }
    return names;
}
// ─── the roster read ─────────────────────────────────────────────────────────
/** The roster text, or null when this repository ships none. */
function readRosterText(cwd) {
    try {
        return node_fs_1.default.readFileSync(node_path_1.default.join(cwd, ...ROSTER_RELATIVE.split('/')), 'utf8');
    }
    catch {
        return null;
    }
}
/**
 * The first role whose owns surface covers a file in the lane, else the first
 * whose reviews surface does.
 *
 * Owns is asked first across every role before reviews is asked of any, because
 * ownership is the stronger claim and a reviewer of 1 file should not outrank
 * the owner of another. Matching uses the SHIPPED anchored matcher, which is
 * also why a glob carrying the single character wildcard is warned about.
 */
function matchRole(input) {
    const lane = asStringArray(input.lane);
    const roles = Array.isArray(input.roles) ? input.roles : [];
    const warnings = [];
    for (const surface of ['owns', 'reviews']) {
        for (const role of roles) {
            if (role === null || typeof role !== 'object' || typeof role.id !== 'string')
                continue;
            const globs = asStringArray(surface === 'owns' ? role.owns : role.reviews);
            for (const glob of globs) {
                if (glob.includes(SINGLE_CHAR_WILDCARD)) {
                    warnings.push(`role ${role.id} declares the ${surface} surface glob '${glob}', which carries the `
                        + 'single character wildcard. The shipped anchored matcher escapes that character and '
                        + 'matches it literally, so this surface matches less than the roster validator admits.');
                }
                const shape = globToRegExp(glob);
                for (const filePath of lane) {
                    if (shape.test(filePath)) {
                        return { role: { id: role.id, surface, glob }, warnings };
                    }
                }
            }
        }
    }
    return { role: null, warnings };
}
// ─── the derived seam gaps ───────────────────────────────────────────────────
/**
 * Every governance surface in 1 lane that NEITHER registry covers.
 *
 * Derived per file rather than listed. Today this yields exactly 1 path across
 * this repository's committed phases. If someone adds that path to a registry
 * the gap disappears on its own, and if someone removes a registry entry the
 * gap appears on its own. A hardcoded list would do neither.
 */
function deriveSeamGaps(input) {
    const gaps = [];
    const hotSeams = asStringArray(input.hotSeams);
    const sharedPaths = asStringArray(input.sharedPaths);
    for (const filePath of asStringArray(input.lane)) {
        if (!GOVERNANCE_SURFACES.includes(basenameOf(filePath)))
            continue;
        const hot = evaluateHotSeam({ filesModified: [filePath], seams: hotSeams });
        if (hot.matched.length > 0)
            continue;
        const shared = evaluateSharedWrite({
            actor: NON_ORCHESTRATOR_ACTOR,
            targetPath: filePath,
            sharedPaths,
        });
        if (shared.decision === 'forbidden')
            continue;
        gaps.push({
            path: filePath,
            node: input.node,
            registries: [HOT_SEAM_REGISTRY, SHARED_STATE_REGISTRY],
        });
    }
    return gaps;
}
// ─── the assembly ────────────────────────────────────────────────────────────
/**
 * The whole `workgraph/v1` document for 1 phase, from the 6 in-repo sources.
 *
 * Nothing here decides anything the shipped cores already decide. The 2 child
 * process reads are injectable, defaulting to a real spawn, which is what lets a
 * test build the entire document without a process while the emitter still
 * drives the real verbs.
 */
function buildWorkgraph(options) {
    const source = options === null || typeof options !== 'object' ? {} : options;
    const cwd = typeof source.cwd === 'string' ? source.cwd : '';
    const phase = typeof source.phase === 'string' ? source.phase : '';
    // The languages, and therefore the roots and the extensions, are DERIVED from
    // the markers on disk. An explicit root list from the caller still wins, and
    // it is never pruned: a caller who names a directory that is not there has
    // made a mistake the walk should still report as unreadable.
    const languages = detectLanguages(cwd);
    const extensions = uniqueStrings(languages.flatMap((profile) => profile.extensions));
    const askedIndexRoots = asStringArray(source.indexRoots);
    const askedScanRoots = asStringArray(source.scanRoots);
    const defaultIndex = resolveDefaultRoots(cwd, languages.flatMap((p) => p.indexRoots));
    const defaultScan = resolveDefaultRoots(cwd, languages.flatMap((p) => p.scanRoots));
    const indexRoots = askedIndexRoots.length > 0 ? askedIndexRoots : defaultIndex.present;
    const scanRoots = askedScanRoots.length > 0 ? askedScanRoots : defaultScan.present;
    const absentRoots = askedIndexRoots.length > 0 ? [] : defaultIndex.absent;
    const index = readPlanIndex({ cwd, phase, runner: source.planIndexRunner });
    if (!index.ok) {
        return {
            ok: false,
            code: 'E_WG_PHASE_UNREADABLE',
            message: index.message,
            document: {},
            errors: [],
        };
    }
    const config = loadConfig(cwd);
    const coordination = (config.coordination || {});
    const model = (config.model || {});
    const hotSeams = asStringArray(coordination.hot_seams);
    const sharedPaths = asStringArray(coordination.shared_state_paths);
    const riskBoundaries = asStringArray(model.risk_boundaries);
    const tierOrder = asStringArray(model.tier_order);
    const frontierRung = tierOrder.length > 0 ? tierOrder[tierOrder.length - 1] : '';
    const stageTiers = (model.stage_tiers || {});
    const defaultTier = typeof model.default_tier === 'string' ? model.default_tier : '';
    const stageTier = typeof stageTiers[EXECUTE_STAGE] === 'string'
        ? (stageTiers[EXECUTE_STAGE])
        : defaultTier;
    const walk = walkSourceFiles(cwd, indexRoots, extensions);
    const crateNames = readCrateNames(cwd, walk.files);
    const scanned = scanImports({ root: cwd, files: walk.files, scanRoots, crateNames });
    const warnings = index.warnings.slice();
    for (const unreadableRoot of walk.unreadable) {
        warnings.push(`the walk could not read ${unreadableRoot}, so it contributed no files`);
    }
    for (const unreadableFile of scanned.unreadable) {
        warnings.push(`the walk could not read ${unreadableFile}, so it contributed no import edges`);
    }
    // THE ABSENCE OF A MEASUREMENT IS NOT A MEASUREMENT. An index holding zero
    // files means the import graph SAW NOTHING, which is a different claim from
    // an index that read the tree and found no coupling, and only the second is
    // evidence about the code. The document carries both: `indexed` says whether
    // a measurement happened at all, and this warning says it in words. The
    // classifier already refuses to write an unbacked verdict in this state,
    // because a write lane absent from the index cannot be on disk, so every
    // declared edge reads unproven rather than unbacked. The warning is what
    // stops a reader concluding that a narrow graph means independent nodes.
    if (walk.files.length === 0) {
        warnings.push('the walk indexed 0 files, so this graph measures NOTHING about imports: the '
            + `languages detected here are ${languages.map((p) => p.id).join(', ')}, indexing `
            + `${extensions.join(' ')} under ${indexRoots.length === 0 ? 'no root at all' : indexRoots.join(' ')}. `
            + 'Every declared edge is unproven for want of a scan, not unbacked. '
            + 'Fix: name the roots this tree actually uses, or add the language this tree is written in.');
    }
    // The roster. Injected text wins so a test can exercise a path this
    // repository, which ships no roster at all, would otherwise never run.
    const rosterText = typeof source.rosterText === 'string'
        ? source.rosterText
        : readRosterText(cwd);
    let roles = [];
    if (rosterText === null) {
        warnings.push(`no roster was found at ${ROSTER_RELATIVE}, so every node carries a null role`);
    }
    else {
        const parsed = parseTeamManifest(rosterText);
        if (parsed.manifest === null) {
            warnings.push(`the roster at ${ROSTER_RELATIVE} did not parse, so every node carries a null role`);
        }
        else {
            roles = parsed.manifest.roles;
        }
    }
    const tierMemo = new Map();
    const resolveMemoized = (tier) => {
        const hit = tierMemo.get(tier);
        if (hit !== undefined)
            return hit;
        const resolved = resolveTierModel({ cwd, tier, runner: source.tierRunner });
        tierMemo.set(tier, resolved);
        return resolved;
    };
    const seamGaps = [];
    const nodes = index.plans.map((plan) => {
        const lane = asStringArray(plan.files_modified).map((p) => workgraph.normalizePath(p));
        const hot = evaluateHotSeam({ filesModified: lane, seams: hotSeams });
        const governanceMatched = [];
        const governanceFiles = [];
        for (const filePath of lane) {
            const shared = evaluateSharedWrite({
                actor: NON_ORCHESTRATOR_ACTOR,
                targetPath: filePath,
                sharedPaths,
            });
            if (shared.decision !== 'forbidden' || shared.matched === null)
                continue;
            if (!governanceMatched.includes(shared.matched))
                governanceMatched.push(shared.matched);
            if (!governanceFiles.includes(filePath))
                governanceFiles.push(filePath);
        }
        for (const gap of deriveSeamGaps({ node: plan.id, lane, hotSeams, sharedPaths })) {
            seamGaps.push(gap);
        }
        const grade = evaluateRiskGrade({
            paths: lane,
            riskBoundaries,
            selfGrade: stageTier,
        });
        const tier = grade.forcesFrontier && frontierRung !== '' ? frontierRung : stageTier;
        const resolved = resolveMemoized(tier);
        const matchedRole = matchRole({ lane, roles });
        for (const warning of matchedRole.warnings) {
            if (!warnings.includes(warning))
                warnings.push(warning);
        }
        return {
            id: plan.id,
            kind: plan.node_kind === 'seam' ? 'seam' : 'plan',
            wave: typeof plan.wave === 'number' ? plan.wave : 0,
            task_count: typeof plan.task_count === 'number' ? plan.task_count : 0,
            autonomous: plan.autonomous === true,
            has_summary: plan.has_summary === true,
            write_lane: lane,
            depends_on: asStringArray(plan.depends_on),
            hot_seams: { decision: hot.decision, matched: hot.matched },
            governance_seams: { matched: governanceMatched, files: governanceFiles },
            role: matchedRole.role,
            tier: {
                stage: EXECUTE_STAGE,
                tier,
                model_id: resolved.model_id,
                ladder_miss: resolved.ladder_miss,
                risk_grade: grade.grade,
                risk_matched: grade.matched,
            },
        };
    });
    const assembled = workgraph.assembleWorkgraph({
        phase: index.phase,
        nodes,
        import_edges: scanned.import_edges,
        existing: walk.files,
        scan_roots: scanRoots,
        generated: {
            index_roots: indexRoots,
            index_roots_absent: absentRoots,
            languages: languages.map((profile) => profile.id),
            extensions,
            // The 1 key that separates "indexed the tree and found no coupling" from
            // "indexed nothing at all". A consumer that reads an edge count without
            // reading this cannot tell a measurement from a silence.
            indexed: walk.files.length > 0,
        },
        scan: scanned.counts,
        seam_gaps: seamGaps,
        unresolved_imports: scanned.unresolved,
        warnings,
    });
    return {
        ok: assembled.ok,
        code: assembled.ok ? '' : 'E_WG_ASSEMBLE',
        message: '',
        document: assembled.document,
        errors: assembled.errors,
    };
}
module.exports = {
    walkSourceFiles,
    scanImports,
    readPlanIndex,
    resolveTierModel,
    readRosterText,
    readCrateNames,
    matchRole,
    deriveSeamGaps,
    buildWorkgraph,
    detectLanguages,
    resolveDefaultRoots,
    stripRustLine,
    parseRustDeclarations,
    expandRustUseTree,
    deriveRustCrates,
    scanRustFile,
    LANGUAGE_PROFILES,
    DEFAULT_INDEX_ROOTS,
    DEFAULT_SCAN_ROOTS,
    INDEXED_EXTENSIONS,
    RUST_EXTENSIONS,
    RUST_INDEX_ROOTS,
    RUST_SCAN_ROOTS,
    GOVERNANCE_SURFACES,
    HOT_SEAM_REGISTRY,
    SHARED_STATE_REGISTRY,
    ROSTER_RELATIVE,
};
