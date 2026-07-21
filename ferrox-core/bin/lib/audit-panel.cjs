"use strict";
/**
 * FLUX-05 audit-panel planner (v1.3 Flux Backbone).
 *
 * Maps a resolved transport (from model-backend) to the concrete 3-eye cross-audit
 * panel, so the audit works on ANY runtime instead of hard-depending on the codex /
 * gemini CLIs:
 *   - 'flux' -> the operator-configured flux model eyes (diverse models via one
 *     endpoint). Aliases come from CONFIG (audit_panel.flux_models), never hardcoded.
 *   - 'cli'  -> the CLIs actually present + the internal adversarial eye.
 *   - 'host' -> the internal eye ONLY (degraded but never zero).
 *
 * Floor invariant: the internal adversarial eye is ALWAYS available (it's just a
 * fresh-context subagent), so a cross-audit can never resolve to zero eyes. When the
 * panel can't reach ≥2 distinct lineages it flags `degraded` so the caller knows the
 * ≥2-lineage bar (Trident) wasn't met.
 *
 * PURE: no fs, no env, no network. Availability is passed in explicitly.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/audit-panel.cjs.
 * `export =` CJS shape; no stdout.
 */
/** The internal adversarial eye — always available, claude lineage. */
const INTERNAL_EYE = { via: 'internal' };
/** Map an eye to a coarse lineage bucket for the ≥2-distinct rule. */
function lineageOf(eye) {
    if (eye.via === 'internal')
        return 'claude';
    if (eye.via === 'cli') {
        if (eye.tool === 'codex')
            return 'openai';
        if (eye.tool === 'gemini')
            return 'google';
        return 'cli:' + (eye.tool || '');
    }
    // flux: derive a rough family from the alias so glm/kimi/reasoning differ
    const m = (eye.model || '').toLowerCase();
    if (m.includes('glm'))
        return 'glm';
    if (m.includes('kimi'))
        return 'kimi';
    if (m.includes('deepseek'))
        return 'deepseek';
    if (m.includes('minimax'))
        return 'minimax';
    if (m.includes('reasoning') || m.includes('opus') || m.includes('fable') || m.includes('gpt'))
        return 'frontier';
    return 'flux:' + m;
}
function finalize(transport, eyes) {
    const distinct = new Set(eyes.map(lineageOf));
    return {
        transport,
        eyes,
        eyeCount: eyes.length,
        distinctLineages: distinct.size,
        degraded: distinct.size < 2,
    };
}
/**
 * PURE. Plan the cross-audit panel for a transport. Never throws; always returns
 * at least the internal eye.
 */
function resolveAuditPanel(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const transport = typeof o.transport === 'string' ? o.transport : 'host';
    if (transport === 'flux') {
        const models = Array.isArray(o.fluxModels)
            ? o.fluxModels.filter((m) => typeof m === 'string' && m !== '')
            : [];
        if (models.length === 0)
            return finalize('flux', [INTERNAL_EYE]); // no models -> degraded
        return finalize('flux', models.map((model) => ({ via: 'flux', model })));
    }
    if (transport === 'cli') {
        const tools = Array.isArray(o.cliTools)
            ? o.cliTools.filter((t) => typeof t === 'string' && t !== '')
            : [];
        const eyes = tools.map((tool) => ({ via: 'cli', tool }));
        eyes.push(INTERNAL_EYE); // the internal eye always joins the CLI panel
        return finalize('cli', eyes);
    }
    // host (or any unrecognized transport): internal-only, degraded.
    return finalize('host', [INTERNAL_EYE]);
}
module.exports = { resolveAuditPanel };
