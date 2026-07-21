"use strict";
/**
 * ANV-04 Anvil executor — the thin, CONSUME-ONLY impure shell (v1.4 Anvil Executor).
 *
 * Shells out to the real `~/dev/anvil/anvil.py` (or an injected path) to run its gated
 * Modify→Verify→Keep loop, and returns a *candidate* + the pure decision. It NEVER lands
 * anything: the caller must still run Factory verify + merge-gate on the candidate.
 *
 * CONSUME-ONLY invariants (non-negotiable):
 *   - spec.md + gate.py are written into a Factory SCRATCH dir, never into anvil's tree.
 *   - the best candidate is COPIED OUT of anvil's drafts into scratch — we read anvil's
 *     output, we never keep files in its tree or commit anything from it.
 *   - `.keys.env` is NEVER read, copied, or referenced. Anvil owns its own key; this
 *     shell requires none and passes none.
 *   - exec is `execFileSync` with an argv array (NO shell string) → no injection surface;
 *     the label is additionally sanitized before it becomes a filename or argv token.
 *
 * The exit code is ignored on purpose (anvil exits 0 even when never green); the verdict
 * comes from parseAnvilResult(stdout). Any failure fails toward normal (ran:false →
 * fallback-normal) so Factory just builds the increment the ordinary way.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/anvil-executor.cjs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const anvilResultParser = require("./anvil-result-parser.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const anvilCandidateGate = require("./anvil-candidate-gate.cjs");
const { parseAnvilResult } = anvilResultParser;
const { decideAnvilCandidate } = anvilCandidateGate;
/** Sanitize a label to a safe filename/argv token: keep only [A-Za-z0-9._-]; never empty, never traversal. */
function safeLabel(label) {
    const raw = typeof label === 'string' ? label : '';
    const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
    return cleaned === '' ? 'anvil' : cleaned.slice(0, 80);
}
/** True if anvil.py exists at `anvilPath` AND a python interpreter is on PATH. Lookup only — nothing is executed. */
function probeAnvilAvailable(anvilPath, python) {
    if (typeof anvilPath !== 'string' || anvilPath === '')
        return false;
    try {
        if (!node_fs_1.default.existsSync(anvilPath) || !node_fs_1.default.statSync(anvilPath).isFile())
            return false;
    }
    catch {
        return false;
    }
    return hasOnPath(python || 'python3');
}
/** True if `bin` resolves on PATH — a lookup only; the binary is never executed. */
function hasOnPath(bin) {
    if (node_path_1.default.isAbsolute(bin)) {
        try {
            return node_fs_1.default.existsSync(bin);
        }
        catch {
            return false;
        }
    }
    const dirs = (process.env.PATH || '').split(node_path_1.default.delimiter);
    for (const d of dirs) {
        if (d === '')
            continue;
        try {
            if (node_fs_1.default.existsSync(node_path_1.default.join(d, bin)))
                return true;
        }
        catch {
            /* ignore unreadable PATH entry */
        }
    }
    return false;
}
const FAIL_PARSED = parseAnvilResult('');
function fellBack(reason, stdout = '') {
    return {
        ran: false,
        parsed: FAIL_PARSED,
        candidatePresent: false,
        candidatePath: null,
        decision: decideAnvilCandidate({ parsed: FAIL_PARSED, candidatePresent: false }),
        stdout,
        reason,
    };
}
/**
 * IMPURE. Run Anvil once against an emitted spec + gate and return the candidate + decision.
 * Never throws — every failure path resolves to a fallback-normal result.
 */
function runAnvil(opts) {
    const python = opts.python || 'python3';
    if (!probeAnvilAvailable(opts.anvilPath, python))
        return fellBack('anvil-unavailable');
    if (typeof opts.scratchDir !== 'string' || opts.scratchDir === '')
        return fellBack('no-scratch-dir');
    const label = safeLabel(opts.label);
    const budget = Number.isFinite(opts.budget) && opts.budget > 0 ? Math.floor(opts.budget) : 12;
    // anvil writes to <dirname(anvilPath)>/drafts by construction; allow override for testing.
    const draftsDir = typeof opts.draftsDir === 'string' && opts.draftsDir !== ''
        ? opts.draftsDir
        : node_path_1.default.join(node_path_1.default.dirname(opts.anvilPath), 'drafts');
    let stdout = '';
    try {
        node_fs_1.default.mkdirSync(opts.scratchDir, { recursive: true });
        const specPath = node_path_1.default.join(opts.scratchDir, `${label}.spec.md`);
        const gatePath = node_path_1.default.join(opts.scratchDir, `${label}.gate.py`);
        node_fs_1.default.writeFileSync(specPath, typeof opts.spec === 'string' ? opts.spec : '');
        node_fs_1.default.writeFileSync(gatePath, typeof opts.gateScript === 'string' ? opts.gateScript : '');
        // NO shell — argv array. execFileSync throws on non-zero exit or timeout; capture stdout either way.
        try {
            stdout = (0, node_child_process_1.execFileSync)(python, [opts.anvilPath, label, specPath, gatePath, String(budget)], {
                encoding: 'utf8',
                timeout: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 600000,
                maxBuffer: 16 * 1024 * 1024,
            });
        }
        catch (e) {
            const err = e;
            stdout = typeof err.stdout === 'string' ? err.stdout : '';
        }
    }
    catch {
        return fellBack('shell-error', stdout);
    }
    const parsed = parseAnvilResult(stdout);
    // Copy the best candidate OUT of anvil's drafts into scratch (consume-only).
    let candidatePresent = false;
    let candidatePath = null;
    try {
        const src = node_path_1.default.join(draftsDir, `${label}.abmcts.py`);
        if (node_fs_1.default.existsSync(src)) {
            const dest = node_path_1.default.join(opts.scratchDir, `${label}.candidate.py`);
            node_fs_1.default.copyFileSync(src, dest);
            candidatePresent = true;
            candidatePath = dest;
        }
    }
    catch {
        candidatePresent = false;
        candidatePath = null;
    }
    const decision = decideAnvilCandidate({ parsed, candidatePresent });
    return { ran: true, parsed, candidatePresent, candidatePath, decision, stdout, reason: decision.reason };
}
module.exports = { runAnvil, probeAnvilAvailable };
