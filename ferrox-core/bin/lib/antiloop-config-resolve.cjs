"use strict";
/**
 * FF-B29 loop-generator config guard: THE ONE RESOLVER.
 *
 * The pure core (src/antiloop-config-guard.cts) reaches for nothing. This module
 * is the impure half: it reads the 5 values off a project and hands them to the
 * core. It lives in its own file, rather than inside either surface, because
 * BOTH surfaces call it: the doctor line in ferrox-core/bin/ferrox-tools.cjs and
 * the config warnings block in the plan-phase init command. Two resolvers that
 * drift apart is the FF-B51 defect class this milestone exists to remove, so
 * there is exactly 1 of them and both callers import this file.
 *
 * THE 5 VALUES DO NOT COME FROM 1 RESOLUTION PATH. That is the whole hazard.
 * A router that reads them uniformly gets undefined for at least 2, the
 * conjunction never holds, and the guard silently never fires. The table below
 * was verified empirically against the live loader with a scratch project
 * carrying all 5 values, and each row is pinned by its own named test in
 * tests/antiloop-config-guard.test.cjs:
 *
 *   key                             flat        nested workflow   raw file
 *   mode                            VALUE       n/a               VALUE
 *   granularity                     VALUE       n/a               VALUE
 *   workflow.security_block_on      undefined   VALUE             VALUE
 *   workflow.inline_plan_threshold  undefined   undefined         VALUE
 *   workflow.auto_advance           VALUE       undefined         VALUE
 *
 * So: mode, granularity and auto advance come from the FLAT projection of the
 * loaded config. The security block threshold comes from the NESTED workflow
 * object, because that key is capability-federated
 * (ferrox-core/bin/lib/capability-registry.cjs) rather than central, and the
 * flat projection drops it. The inline plan threshold comes from NEITHER loader
 * path: it is declared in the central schema manifest but has no entry in the
 * defaults manifest and no reader anywhere in the source tree, so the loader
 * drops it on both paths even when a project writes it explicitly. It is read
 * from the RAW project config JSON.
 *
 * The generic config-get verb is NOT used for the inline threshold either. It
 * resolves the key when it is set but THROWS a key-not-found error when it is
 * unset, which is the common case, so a resolver built on it would crash on most
 * projects rather than reporting the value as unresolved.
 *
 * EVERY READ IS WRAPPED. A failure yields `undefined`, which is the pure core's
 * UNRESOLVED marker, and the core then names the input in its unresolved list.
 * A broken read must be VISIBLE. Silently collapsing it into a value that makes
 * the conjunction fail is exactly how a guard ships dead.
 *
 * ADR-457 build-at-publish: this TS source compiles to the emitted artifact
 * ferrox-core/bin/lib/antiloop-config-resolve.cjs. `export =` CJS shape; no stdout.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const configLoader = require("./config-loader.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const configGuard = require("./antiloop-config-guard.cjs");
const { loadConfig } = configLoader;
const { evaluateLoopConfigCombination } = configGuard;
/** Run a read, collapsing ANY failure to the unresolved marker. */
function safeRead(read) {
    try {
        return read();
    }
    catch {
        return undefined;
    }
}
/** The loaded config, or an empty object when the loader itself fails. */
function flatConfig(root) {
    const cfg = safeRead(() => loadConfig(root));
    return cfg && typeof cfg === 'object' ? cfg : {};
}
/** The nested `workflow` object off the loaded config, or an empty object. */
function nestedWorkflow(root) {
    const cfg = flatConfig(root);
    const w = cfg['workflow'];
    return w && typeof w === 'object' ? w : {};
}
/**
 * The RAW project config JSON, unmerged and unresolved. This is the only path
 * that returns `workflow.inline_plan_threshold`. A missing or unparseable file
 * yields an empty object, so the caller gets the unresolved marker rather than
 * an exception.
 */
function rawProjectConfig(root) {
    const parsed = safeRead(() => {
        const target = path.join(root, '.planning', 'config.json');
        return JSON.parse(fs.readFileSync(target, 'utf8'));
    });
    return parsed && typeof parsed === 'object' ? parsed : {};
}
/** The `workflow` block of the raw project config, or an empty object. */
function rawWorkflow(root) {
    const w = rawProjectConfig(root)['workflow'];
    return w && typeof w === 'object' ? w : {};
}
/**
 * Resolve the 5 values through the 3 paths the live loader requires. Every read
 * is wrapped, so this function never throws and an unresolvable value arrives at
 * the core as `undefined`, which the core reports by name.
 */
function resolveLoopConfigInputs(root) {
    const flat = flatConfig(root);
    const nested = nestedWorkflow(root);
    const raw = rawWorkflow(root);
    return {
        // FLAT projection.
        mode: safeRead(() => flat['mode']),
        granularity: safeRead(() => flat['granularity']),
        // NESTED workflow object. The flat projection drops this one.
        securityBlockOn: safeRead(() => nested['security_block_on']),
        // RAW project config file. Both loader paths drop this one.
        inlinePlanThreshold: safeRead(() => raw['inline_plan_threshold']),
        // FLAT projection. The nested read returns undefined even when the project sets it.
        autoAdvance: safeRead(() => flat['auto_advance']),
    };
}
/**
 * Report what each of the 3 paths returns for each of the 5 keys. This exists so
 * the resolution table is DERIVED from the live loader at test time rather than
 * copied from a document that can rot, and so a refactor that unifies the reads
 * fails a named test instead of quietly disabling the guard.
 */
function observeResolutionPaths(root) {
    const flat = flatConfig(root);
    const nested = nestedWorkflow(root);
    const raw = rawWorkflow(root);
    const rawTop = rawProjectConfig(root);
    return {
        mode: { flat: flat['mode'], nested: nested['mode'], raw: rawTop['mode'] },
        granularity: { flat: flat['granularity'], nested: nested['granularity'], raw: rawTop['granularity'] },
        securityBlockOn: { flat: flat['security_block_on'], nested: nested['security_block_on'], raw: raw['security_block_on'] },
        inlinePlanThreshold: { flat: flat['inline_plan_threshold'], nested: nested['inline_plan_threshold'], raw: raw['inline_plan_threshold'] },
        autoAdvance: { flat: flat['auto_advance'], nested: nested['auto_advance'], raw: raw['auto_advance'] },
    };
}
/** Resolve and decide in 1 call. The shape both surfaces consume. */
function evaluateProjectLoopConfig(root) {
    return evaluateLoopConfigCombination(resolveLoopConfigInputs(root));
}
/**
 * The 1 line the doctor verb prints. The firing case names the combination and
 * every matched member. The quiet case ALWAYS reports the unresolved count,
 * because without it a guard whose reads are all broken prints identically to a
 * safely configured project, which is the dead-guard failure expressed as a user
 * interface.
 */
function formatLoopConfigDoctorLine(result) {
    if (result.decision === 'warn-loop-combination') {
        return `config guard: WARNING, the loop combination is present: ${result.matched.join(', ')}. `
            + 'Together these 5 settings generate plans faster than they can be accepted (FF-B29, proven live: '
            + '74 plan files and 2 accepted increments). No single value is wrong. This is a warning and blocks nothing.';
    }
    if (result.unresolved.length > 0) {
        return `config guard: ok, no loop-generating combination, but ${result.unresolved.length} of 5 inputs unresolved: `
            + `${result.unresolved.join(', ')}. An unresolved input can never match, so the guard cannot fire on it.`;
    }
    return 'config guard: ok, no loop-generating combination, 5 of 5 inputs resolved.';
}
module.exports = {
    resolveLoopConfigInputs,
    observeResolutionPaths,
    evaluateProjectLoopConfig,
    formatLoopConfigDoctorLine,
};
