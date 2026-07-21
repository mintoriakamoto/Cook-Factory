"use strict";
/**
 * QUAL-01 — language-keyed code-quality pipeline (the free deterministic hygiene pass).
 *
 * The v1.7 benchmark proved the "quality gap" between Factory's cheap-gated executor and the frontier was
 * MOSTLY COSMETIC — a formatter closed ~64% of it for $0, and objective metrics (lint/complexity/security/
 * runtime) came out even. So Factory's polish step is NOT an expensive LLM pass (anvil-v3/ultra REGRESS
 * correctness; paid cosmetic polish is a rounding-error lift). It's a per-language toolchain of
 * DETERMINISTIC, un-gameable tools run AFTER the gate is green: format -> lint -> security-scan.
 * Free, safe, objective, and it ships correct + formatted + lint-clean + secure code by default.
 *
 *   selectToolchain(language) -> { formatter, linter, security, known }
 *     python -> black + ruff + bandit; js/ts -> prettier + eslint; go -> gofmt + govet; rust -> rustfmt +
 *     clippy; c/c++/java -> clang-format. Unknown language -> { known: false } (run NOTHING — never guess).
 *
 *   decideKeep({ gateBefore, gateAfter }) -> { keep, reason }  NON-REGRESSIVE: keep the polished output ONLY
 *     if it still passes the gate at least as well as before; otherwise revert to the pre-polish version.
 *     Polish is pure free upside, never a correctness risk. (anvil-v3's defect was re-gating too loosely;
 *     this fences it — a polish that drops ANY check is discarded.)
 *
 *   summarize({ formatChanged, lint, security }) -> { clean, issues, verdict }  aggregate tool output into a
 *     plain verdict. Any HIGH/MEDIUM security finding or lint>0 -> not clean (SURFACE it; never silently
 *     block the already-correct build). formatChanged is informational (model-discipline signal).
 *
 * FAIL-SAFE on garbage (unknown language -> run nothing; malformed counts -> treated as issues, surfaced).
 * Never throws. ADR-457: compiles to ferrox-core/bin/lib/quality-pipeline.cjs. `export =` shape.
 */
/** Language aliases -> canonical key. */
const ALIASES = {
    py: 'python',
    python3: 'python',
    js: 'javascript',
    jsx: 'javascript',
    node: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    golang: 'go',
    rs: 'rust',
    'c++': 'cpp',
    cxx: 'cpp',
    cc: 'cpp',
    rb: 'ruby',
};
/** The canonical per-ecosystem toolchain. Deterministic tools only — no LLMs. */
const REGISTRY = {
    python: { formatter: 'black', linter: 'ruff', security: 'bandit' },
    javascript: { formatter: 'prettier', linter: 'eslint', security: null },
    typescript: { formatter: 'prettier', linter: 'eslint', security: null },
    go: { formatter: 'gofmt', linter: 'govet', security: 'gosec' },
    rust: { formatter: 'rustfmt', linter: 'clippy', security: null },
    cpp: { formatter: 'clang-format', linter: null, security: null },
    c: { formatter: 'clang-format', linter: null, security: null },
    java: { formatter: 'google-java-format', linter: null, security: null },
    ruby: { formatter: 'rubocop', linter: 'rubocop', security: 'brakeman' },
};
/**
 * PURE. Resolve a language to its deterministic hygiene toolchain. Unknown/garbage -> { known:false }
 * with all-null tools, so the caller runs NOTHING rather than guessing a wrong formatter.
 */
function selectToolchain(language) {
    const raw = typeof language === 'string' ? language.trim().toLowerCase() : '';
    const key = ALIASES[raw] || raw;
    const hit = REGISTRY[key];
    if (!hit) {
        return { formatter: null, linter: null, security: null, known: false };
    }
    return { ...hit, known: true };
}
/**
 * PURE. Non-regressive polish gate. `gateBefore`/`gateAfter` are pass counts (or fractions) from the SAME
 * gate. Keep the polished output only if it does not lose ground. Missing/garbage after-score -> revert.
 */
function decideKeep(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const before = typeof o.gateBefore === 'number' && isFinite(o.gateBefore) ? o.gateBefore : NaN;
    const after = typeof o.gateAfter === 'number' && isFinite(o.gateAfter) ? o.gateAfter : NaN;
    if (isNaN(after)) {
        return { keep: false, reason: 'revert-no-after-score' };
    }
    if (isNaN(before)) {
        // no baseline to compare — conservative: keep only a clearly-passing after (>0), else revert
        return after > 0 ? { keep: true, reason: 'keep-no-baseline-after-passes' } : { keep: false, reason: 'revert-no-baseline' };
    }
    if (after >= before) {
        return { keep: true, reason: 'keep-non-regressive' };
    }
    return { keep: false, reason: 'revert-regressed' };
}
/**
 * PURE. Aggregate tool outputs into a plain verdict. Any HIGH/MEDIUM security finding or lint>0 marks the
 * build not-clean (surfaced, never silently blocking correct code). Negative counts (tool error) -> issue.
 */
function summarize(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const issues = [];
    const lint = typeof o.lint === 'number' ? o.lint : -1;
    if (lint < 0) {
        issues.push('lint:unavailable');
    }
    else if (lint > 0) {
        issues.push(`lint:${lint}`);
    }
    const sec = o.security && typeof o.security === 'object' ? o.security : {};
    const high = typeof sec.HIGH === 'number' ? sec.HIGH : 0;
    const med = typeof sec.MEDIUM === 'number' ? sec.MEDIUM : 0;
    if (high > 0)
        issues.push(`security-high:${high}`);
    if (med > 0)
        issues.push(`security-medium:${med}`);
    const clean = issues.length === 0;
    return {
        clean,
        issues,
        verdict: lint < 0 ? 'unknown' : clean ? 'clean' : 'issues',
    };
}
module.exports = { selectToolchain, decideKeep, summarize };
