"use strict";
/**
 * SC2, the probe half: an adapter is READY only when it answers a REAL prompt
 * with the nonce that prompt carried.
 *
 * WHY THIS MODULE EXISTS AT ALL. CONTEXT D6 records the evidence, from this
 * milestone's own 3 lineage audit: 1 adapter needed 2 retries for a bad model
 * alias and a wrong workspace root, 1 burned its budget and never emitted a
 * final report, and 1 returned a hard 429 for an account with no balance. Every
 * 1 of those 3 answers `--version` correctly and exits 0. A presence probe is
 * therefore a guard that cannot fire against the failures that actually occur,
 * and this repository already ships one of exactly that shape at
 * `src/trident-command-router.cts:101`. It would have reported all 3 of those
 * adapters healthy.
 *
 * THE INVOCATION CROSSES `src/external-cli.cts` AND NO OTHER SEAM. Every reason
 * is a property that seam already has: it is argv safe with `shell: false`, it
 * is single shot with no retry loop, it carries a bounded timeout so a hung
 * adapter cannot stall a preflight, it returns `{ present: false }` and never
 * throws on ENOENT or timeout, and supplying `run` replaces the spawn entirely.
 * That last property is what lets the 429 arm, the banner arm and the timeout
 * arm all be driven under test without a real 429 and without depending on
 * which adapters happen to be installed on the machine running the suite.
 *
 * THE NONCE IS AN ARGUMENT AND IS NEVER GENERATED HERE. This module holds no
 * clock, no process identity and no source of entropy, so 2 calls on the same
 * input return the same answer and every arm is deterministic. The caller mints
 * the nonce, and the fleet doctor verb in `ferrox-core/bin/ferrox-tools.cjs`
 * owns that choice.
 *
 * 2 VACUOUS PASSES ARE CLOSED BY CONSTRUCTION rather than by a comment.
 *
 *   1. An empty roster returns ERROR and cannot reach READY. "Every adapter
 *      passed" is vacuously true of 0 adapters, and this repository was bitten
 *      by exactly that shape inside `lint:ci` at
 *      `scripts/lint-pr-check-project-dir.cjs`, repaired by plan 20-02.
 *   2. An empty nonce returns ERROR and cannot reach READY. `x.includes('')` is
 *      true for every string, so an unchecked empty nonce would turn the whole
 *      containment test into a presence test without changing a line of it.
 *
 * AN ADAPTER THE ENGINE CANNOT DISPATCH TO IS NOT PROBED AND IS NEVER READY. It
 * gets its own verdict, `not-dispatchable`, and no call is spent on it. A green
 * light on a lane the fleet cannot use is a guard firing on a false premise,
 * which is the class this whole phase exists to eliminate.
 *
 * ADR-457 build-at-publish: this TS source compiles to the artifact
 * ferrox-core/bin/lib/fleet-probe.cjs, which is TRACKED and committed. CJS
 * module shape (`export =`). The module owns NO stdout.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const externalCliMod = require("./external-cli.cjs");
const { runExternalCli } = externalCliMod;
/** The 3 verdicts, frozen. Callers branch on these, never on prose. */
const PROBE_VERDICTS = Object.freeze({
    READY: 'READY',
    NOT_READY: 'NOT_READY',
    ERROR: 'ERROR',
});
/**
 * Every reason a probe can decline, frozen.
 *
 * `absent` covers ENOENT, the bounded timeout and any spawn error, because the
 * seam collapses all 3 onto `present: false` and none of them is an answer.
 *
 * `bad-nonce` is a CALLER error rather than an adapter verdict, and it exists so
 * that an empty or malformed nonce refuses loudly instead of turning the
 * containment check into a tautology.
 */
const PROBE_REASONS = Object.freeze({
    ABSENT: 'absent',
    EXIT: 'exit',
    EMPTY: 'empty',
    NO_NONCE: 'no-nonce',
    NOT_DISPATCHABLE: 'not-dispatchable',
    EMPTY_ROSTER: 'empty-roster',
    BAD_NONCE: 'bad-nonce',
});
/**
 * The argv prefix per adapter identity. The prompt is appended as the FINAL
 * element, which is the shape the vendored engine itself uses at
 * `ferrox-core/bin/vendor/ratchet/bin/ratchet-exec:763`.
 *
 * claude, codex and gemini carry the engine's own prefixes byte for byte, and
 * `tests/fleet-probe.test.cjs` reads that vendored file on every run and asserts
 * the agreement rather than trusting this copy. Do NOT parse the vendored Python
 * at run time: the file is byte pinned, a parser over it would be a second
 * fragile dependency, and a drift TEST answers the same question without one.
 *
 * `mock` is the zero spend lane. The engine special cases it at
 * `ratchet-exec:760-761` and runs `$RATCHET_MOCK_CMD` through bash, which is a
 * shell string and therefore not a shape this seam will ever produce. Here it is
 * `echo`, so the adapter answers by returning the prompt, nonce included. That
 * exercises the entire path, invocation build through seam through verdict, with
 * no network, no model and no spend. It is excluded from the argv agreement
 * check for the stated reason that the engine does not carry it in PROFILES at
 * all, and the test asserts the engine's mock branch exists rather than assuming
 * it.
 */
const ADAPTER_PROFILES = Object.freeze({
    claude: Object.freeze(['claude', '-p', '--dangerously-skip-permissions']),
    codex: Object.freeze(['codex', 'exec', '--skip-git-repo-check', '-s', 'workspace-write']),
    gemini: Object.freeze(['gemini', '--skip-trust', '-p']),
    mock: Object.freeze(['echo']),
});
/** The identity the engine dispatches OUTSIDE its PROFILES table. */
const ENGINE_MOCK_IDENTITY = 'mock';
/**
 * Adapter identities the ENGINE can dispatch to that this project does NOT
 * probe, each with its reason. A table that names its own exclusions cannot
 * silently shrink; a comment cannot be read by a test. Same shape as the
 * `GUARD_SURFACE` roster plan 20-01 built.
 */
const NOT_PROBED = Object.freeze({
    'wayland-core': 'the universal fallback lane, routed through a metered service rather than a locally '
        + 'installed adapter binary, so a probe of it measures that service rather than this machine. Out of '
        + 'scope for phase 20 and recorded here rather than dropped.',
});
/** The bounded timeout for 1 probe call. T-20-20. */
const PROBE_TIMEOUT_MS = 60_000;
/** True only for a usable nonce. An empty nonce matches every string. */
function _isUsableNonce(nonce) {
    return typeof nonce === 'string' && nonce.trim() !== '';
}
/** Is this identity one the probe carries an argv profile for. */
function isDispatchable(identity) {
    return typeof identity === 'string'
        && Object.prototype.hasOwnProperty.call(ADAPTER_PROFILES, identity);
}
/**
 * The prompt. It asks for the nonce back and nothing else, so a correct answer
 * is short, is checkable by containment, and cannot be produced by a banner.
 *
 * Refuses a nonce that is not a non empty string rather than building a prompt
 * nobody can verify an answer to.
 */
function buildProbePrompt(nonce) {
    if (!_isUsableNonce(nonce)) {
        throw new Error('fleet probe: the nonce must be a non empty string. An empty nonce is contained by every string, '
            + 'which turns the answer check into a presence check.');
    }
    return `Reply with exactly this token and nothing else: ${nonce}`;
}
/**
 * An identity plus a prompt to a bin and an argv ARRAY, with the prompt as the
 * FINAL element.
 *
 * `opts.bin` replaces the profile head only. It exists because the fleet doctor
 * verb resolves a candidate binary NAME through the shipped runtime alias
 * manifest for the identities that manifest carries, and the argv tail is the
 * engine's and must not move with it. It is always a bare binary name resolved
 * through PATH, never a path.
 */
function buildProbeInvocation(identity, prompt, opts) {
    if (!isDispatchable(identity)) {
        throw new Error(`fleet probe: no argv profile for adapter '${String(identity)}'. The dispatchable set is `
            + `${Object.keys(ADAPTER_PROFILES).join(', ')}.`);
    }
    if (typeof prompt !== 'string' || prompt === '') {
        throw new Error('fleet probe: the prompt must be a non empty string');
    }
    const profile = ADAPTER_PROFILES[identity];
    const bin = (opts && typeof opts.bin === 'string' && opts.bin !== '') ? opts.bin : profile[0];
    return { bin, args: [...profile.slice(1), prompt] };
}
/**
 * The `ExternalCliResult` union onto a verdict. This mapping IS the difference
 * between a presence probe and a real probe, so it is stated in one place and in
 * this order:
 *
 *   identity not dispatchable  NOT_READY, not-dispatchable  a lane the engine cannot use
 *   nonce unusable             ERROR,     bad-nonce         a caller error, never an adapter verdict
 *   present false              NOT_READY, absent            ENOENT, timeout, any spawn error
 *   code not 0                 NOT_READY, exit              the 429 and the auth refusal
 *   stdout empty               NOT_READY, empty             burned its budget, emitted no report
 *   nonce not in stdout        NOT_READY, no-nonce          the banner and the bad model alias
 *   nonce in stdout, code 0    READY
 *
 * Exit beats content deliberately: a rate limiter that echoes the request back
 * must not buy its way to READY on containment alone.
 */
function evaluateProbe(input) {
    const source = (input === null || input === undefined) ? {} : input;
    const identity = typeof source.identity === 'string' ? source.identity : String(source.identity);
    if (!isDispatchable(source.identity)) {
        return { identity, verdict: PROBE_VERDICTS.NOT_READY, reason: PROBE_REASONS.NOT_DISPATCHABLE, bin: null };
    }
    if (!_isUsableNonce(source.nonce)) {
        return { identity, verdict: PROBE_VERDICTS.ERROR, reason: PROBE_REASONS.BAD_NONCE, bin: null };
    }
    const result = source.result;
    if (result === null || typeof result !== 'object') {
        return { identity, verdict: PROBE_VERDICTS.NOT_READY, reason: PROBE_REASONS.ABSENT, bin: null };
    }
    const shaped = result;
    if (shaped.present !== true) {
        return { identity, verdict: PROBE_VERDICTS.NOT_READY, reason: PROBE_REASONS.ABSENT, bin: null };
    }
    if (shaped.code !== 0) {
        return { identity, verdict: PROBE_VERDICTS.NOT_READY, reason: PROBE_REASONS.EXIT, bin: null };
    }
    const stdout = typeof shaped.stdout === 'string' ? shaped.stdout : '';
    if (stdout.trim() === '') {
        return { identity, verdict: PROBE_VERDICTS.NOT_READY, reason: PROBE_REASONS.EMPTY, bin: null };
    }
    if (!stdout.includes(source.nonce)) {
        return { identity, verdict: PROBE_VERDICTS.NOT_READY, reason: PROBE_REASONS.NO_NONCE, bin: null };
    }
    return { identity, verdict: PROBE_VERDICTS.READY, reason: null, bin: null };
}
/**
 * A roster plus its per adapter verdicts to 1 overall verdict.
 *
 * The empty roster branch is FIRST and returns before any fold runs, so there is
 * no path on which 0 adapters can be folded into "nothing failed". A roster
 * entry with no verdict at all counts as not READY: a probe that was never run
 * is not a probe that passed.
 */
function evaluateRoster(input) {
    const source = (input === null || input === undefined) ? {} : input;
    const roster = Array.isArray(source.roster) ? source.roster : [];
    const named = roster.filter((id) => typeof id === 'string' && id !== '');
    if (named.length === 0) {
        return { verdict: PROBE_VERDICTS.ERROR, reason: PROBE_REASONS.EMPTY_ROSTER, not_ready: [] };
    }
    const byIdentity = new Map();
    const verdicts = Array.isArray(source.verdicts) ? source.verdicts : [];
    for (const raw of verdicts) {
        if (raw === null || typeof raw !== 'object')
            continue;
        const v = raw;
        if (typeof v.identity !== 'string')
            continue;
        byIdentity.set(v.identity, typeof v.verdict === 'string' ? v.verdict : PROBE_VERDICTS.ERROR);
    }
    const notReady = [];
    for (const identity of named) {
        if (byIdentity.get(identity) !== PROBE_VERDICTS.READY)
            notReady.push(identity);
    }
    if (notReady.length === 0) {
        return { verdict: PROBE_VERDICTS.READY, reason: null, not_ready: [] };
    }
    return { verdict: PROBE_VERDICTS.NOT_READY, reason: null, not_ready: notReady };
}
/**
 * Probe 1 adapter: 1 call, bounded, impure only by injection.
 *
 * A non dispatchable identity and an unusable nonce both refuse BEFORE the seam
 * is touched, so neither spends a call. That is not an optimisation: paying an
 * adapter vendor to discover that a lane the engine cannot dispatch to is dead
 * would be spend with no answer attached.
 */
function runProbe(input) {
    const source = (input === null || input === undefined) ? {} : input;
    const identity = typeof source.identity === 'string' ? source.identity : String(source.identity);
    if (!isDispatchable(source.identity)) {
        return { identity, verdict: PROBE_VERDICTS.NOT_READY, reason: PROBE_REASONS.NOT_DISPATCHABLE, bin: null };
    }
    if (!_isUsableNonce(source.nonce)) {
        return { identity, verdict: PROBE_VERDICTS.ERROR, reason: PROBE_REASONS.BAD_NONCE, bin: null };
    }
    const prompt = buildProbePrompt(source.nonce);
    const invocation = buildProbeInvocation(identity, prompt, { bin: source.bin });
    const timeoutMs = typeof source.timeoutMs === 'number' && Number.isFinite(source.timeoutMs) && source.timeoutMs > 0
        ? source.timeoutMs
        : PROBE_TIMEOUT_MS;
    const result = runExternalCli({
        bin: invocation.bin,
        args: invocation.args,
        cwd: source.cwd,
        timeoutMs,
        run: source.run,
    });
    const verdict = evaluateProbe({ identity, nonce: source.nonce, result });
    return { ...verdict, bin: invocation.bin };
}
/**
 * Extract the engine's adapter identities and argv prefixes from the text of
 * `ferrox-core/bin/vendor/ratchet/bin/ratchet-exec`.
 *
 * REFUSES rather than returning nothing. An extraction that silently yields 0
 * identities is the empty payload shape this phase exists to remove, and a
 * regular expression that stops matching after an upstream reformat produces
 * precisely that. So a missing literal, an unterminated literal and a literal
 * carrying 0 identities all throw, and the test drives all 3.
 *
 * This is a TEST time reader over a byte pinned file, never a run time
 * dependency. Reading the file is not running it, so the interpreter byte cache
 * is never touched.
 */
function extractEngineProfiles(text) {
    if (typeof text !== 'string' || text === '') {
        throw new Error('fleet probe: the engine source text is empty, so no PROFILES literal can be located');
    }
    const lines = text.split(/\r?\n/);
    let start = -1;
    for (let i = 0; i < lines.length; i += 1) {
        if (/^PROFILES\s*=\s*\{\s*$/.test(lines[i])) {
            start = i;
            break;
        }
    }
    if (start === -1) {
        throw new Error('fleet probe: no PROFILES literal found in the engine source. The roster agreement check cannot '
            + 'pass on an extraction it never made.');
    }
    const profiles = {};
    let closed = false;
    for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\}/.test(line)) {
            closed = true;
            break;
        }
        const entry = /^\s*"([^"]+)"\s*:\s*\[([^\]]*)\]\s*,?\s*$/.exec(line);
        if (!entry)
            continue;
        const argv = [...entry[2].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
        if (argv.length === 0)
            continue;
        profiles[entry[1]] = argv;
    }
    if (!closed) {
        throw new Error('fleet probe: the PROFILES literal is not terminated, so the extraction is not trustworthy');
    }
    if (Object.keys(profiles).length === 0) {
        throw new Error('fleet probe: the PROFILES literal yielded 0 adapter identities. An empty extraction must refuse '
            + 'rather than agree with everything.');
    }
    return profiles;
}
module.exports = {
    ADAPTER_PROFILES,
    PROBE_VERDICTS,
    PROBE_REASONS,
    PROBE_TIMEOUT_MS,
    ENGINE_MOCK_IDENTITY,
    NOT_PROBED,
    isDispatchable,
    buildProbePrompt,
    buildProbeInvocation,
    evaluateProbe,
    evaluateRoster,
    runProbe,
    extractEngineProfiles,
};
