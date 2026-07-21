"use strict";
/**
 * FLUX-06 OpenAI-compatible chat client (v1.3 Flux Backbone).
 *
 * The thin transport used when model-backend resolves transport='flux'. It speaks the
 * OpenAI `/chat/completions` shape to a CONFIGURED base_url — so it works with FluxRouter
 * or any OpenAI-compatible endpoint — and reads the API key from the operator's ENV by
 * variable NAME.
 *
 * SECRET BOUNDARY (v1.3 invariant): no endpoint URL, provider list, or key is hardcoded.
 * base_url comes from config; the key is read from process.env[keyEnv] at call time and
 * used only as the Bearer header — it is never returned, logged, or stored. A missing key
 * throws BEFORE any network call. Zero flux-router internals — Factory stays MIT-publishable.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/openai-client.cjs.
 * `export =` CJS shape; no stdout.
 */
/**
 * POST a chat completion to <baseUrl>/chat/completions with the env key as a Bearer token.
 * Throws on a missing key (before any network I/O) or a non-2xx response.
 */
async function chatCompletion(opts) {
    const key = process.env[opts.keyEnv];
    if (typeof key !== 'string' || key === '') {
        // Fail BEFORE any network call — never leak that we tried, never send an empty Bearer.
        throw new Error(`flux-backbone: no key in env ${opts.keyEnv}`);
    }
    const base = opts.baseUrl.replace(/\/+$/, '');
    const url = `${base}/chat/completions`;
    const body = JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
    });
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 120000),
    });
    if (!res.ok) {
        throw new Error(`flux-backbone: HTTP ${res.status} from provider`);
    }
    const data = (await res.json());
    const content = data && Array.isArray(data.choices) && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : undefined;
    return {
        text: typeof content === 'string' ? content : '',
        model: typeof data.model === 'string' ? data.model : opts.model,
    };
}
module.exports = { chatCompletion };
