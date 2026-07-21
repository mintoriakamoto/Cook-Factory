"use strict";
/**
 * ANV-02 Anvil result parser (v1.4 Anvil Executor).
 *
 * Anvil (`~/dev/anvil/anvil.py`) exits 0 EVEN WHEN IT NEVER REACHED GREEN — the exit
 * code is meaningless. The truth is the last ledger line it prints:
 *
 *   FINAL best=N/M  calls=K  out_tok=T  flat_cost=$X  TRUE_cost=$Y
 *
 * This pure parser scrapes that line. `green = total > 0 && best >= total`.
 *
 * FAIL-CLOSED: a missing/garbage FINAL line yields `green:false` with null fields — a
 * result we cannot score is treated as NOT green, so the candidate faces the full
 * normal gate and never gets a free pass. PURE: string in, object out. Never throws.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/anvil-result-parser.cjs. `export =` CJS shape; no stdout.
 */
const FAIL_CLOSED = {
    best: null, total: null, calls: null, outTok: null,
    flatCostUsd: null, trueCostUsd: null, green: false,
};
/** Pull the first capture of `re` from `s` as a number, or null. */
function num(s, re) {
    const m = s.match(re);
    if (!m)
        return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
}
/**
 * PURE. Parse Anvil's stdout. Uses the LAST `FINAL best=N/M …` line (the authoritative
 * final ledger entry). Any parse failure fails closed to a not-green result.
 */
function parseAnvilResult(stdout) {
    if (typeof stdout !== 'string' || stdout === '')
        return { ...FAIL_CLOSED };
    // find the LAST line that starts a FINAL ledger entry with a best=N/M score
    const finals = stdout
        .split('\n')
        .filter((l) => /FINAL\s+best=\d+\s*\/\s*\d+/.test(l));
    if (finals.length === 0)
        return { ...FAIL_CLOSED };
    const line = finals[finals.length - 1];
    const scoreM = line.match(/best=(\d+)\s*\/\s*(\d+)/);
    if (!scoreM)
        return { ...FAIL_CLOSED };
    const best = Number(scoreM[1]);
    const total = Number(scoreM[2]);
    if (!Number.isFinite(best) || !Number.isFinite(total))
        return { ...FAIL_CLOSED };
    return {
        best,
        total,
        calls: num(line, /calls=(\d+)/),
        outTok: num(line, /out_tok=(\d+)/),
        flatCostUsd: num(line, /flat_cost=\$([\d.]+)/),
        trueCostUsd: num(line, /TRUE_cost=\$([\d.]+)/),
        green: total > 0 && best >= total,
    };
}
module.exports = { parseAnvilResult };
