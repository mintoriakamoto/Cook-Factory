"use strict";
/**
 * FLUX-02 / FF-B26 model-backend resolver (v1.3 Flux Backbone).
 *
 * The pure decision at the heart of the runtime-agnostic, cost-routed model layer:
 * given the provider config, a tier, the tier_models ladder, and what is AVAILABLE
 * (flux key present? host CLIs?), decide HOW to reach a model and WHICH model.
 *
 * Degradation ladder — always resolves, never breaks:
 *   1. provider === 'flux' (EXACT) AND fluxKeyPresent -> transport 'flux'
 *   2. else host CLIs present                          -> transport 'cli'
 *   3. else                                            -> transport 'host' (host-native)
 *
 * FF-B26: modelId is a plain lookup in the tier_models ladder — arbitrary rung
 * names (so a 5-rung ladder works). An unknown tier / missing ladder degrades
 * modelId to null WITHOUT changing the transport decision, and never throws.
 *
 * SECRET BOUNDARY (v1.3 invariant): this core knows NOTHING about flux-router —
 * no endpoint, no pricing, no provider list, no key. The key presence is passed
 * in as a boolean the caller derived from the operator's env; the model aliases
 * come from the operator's config. Nothing here is flux-internal. Factory stays
 * MIT-publishable.
 *
 * PURE: no fs, no env, no clock, no network. All availability is explicit input.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/model-backend.cjs. `export =` CJS shape; no stdout.
 */
/** Look up a tier in the ladder; null for a missing/garbage ladder or unknown rung. */
function ladderModel(tierModels, tier) {
    if (typeof tier !== 'string' || tier === '')
        return { modelId: null, miss: 'non-string-tier' };
    if (!tierModels || typeof tierModels !== 'object' || Array.isArray(tierModels)) {
        return { modelId: null, miss: 'no-ladder' };
    }
    const map = tierModels;
    if (!Object.hasOwn(map, tier))
        return { modelId: null, miss: 'unknown-tier' };
    const v = map[tier];
    return typeof v === 'string' && v !== ''
        ? { modelId: v, miss: '' }
        : { modelId: null, miss: 'empty-model' };
}
/**
 * PURE. Resolve the model backend (transport + model-id) with graceful degradation.
 * Never throws — a fully-empty argument resolves to host-native.
 */
function resolveModelBackend(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const tierStr = typeof o.tier === 'string' ? o.tier : '';
    const { modelId, miss } = ladderModel(o.tierModels, o.tier);
    // 1. Flux: exact provider match AND a key the caller found in the env.
    const fluxWanted = o.provider === 'flux';
    const fluxKey = o.fluxKeyPresent === true;
    const cli = o.cliAvailable === true;
    let transport;
    const notes = [];
    if (fluxWanted && fluxKey) {
        transport = 'flux';
    }
    else if (cli) {
        transport = 'cli';
        if (fluxWanted && !fluxKey)
            notes.push('no-flux-key');
    }
    else {
        transport = 'host';
        notes.push('host-native');
        if (fluxWanted && !fluxKey)
            notes.push('no-flux-key');
    }
    if (miss)
        notes.push(miss);
    // On the host-native path the ladder aliases are un-runnable (nothing resolves
    // them), so the host uses its OWN model — modelId is null regardless of the
    // ladder. flux/cli keep the resolved alias.
    const effectiveModelId = transport === 'host' ? null : modelId;
    return {
        transport,
        tier: tierStr,
        modelId: effectiveModelId,
        reason: notes.length > 0 ? notes.join('+') : 'ok',
    };
}
module.exports = { resolveModelBackend };
