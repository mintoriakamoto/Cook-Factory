/**
 * Minimal ambient typing for js-yaml v4 (MIT, direct dependency since Wave 1 of
 * MILESTONE v1.9). Only the safe-by-default load() surface is used by gate-seal.cts;
 * typing it here avoids pulling @types/js-yaml for 1 function.
 */
declare module 'js-yaml' {
  function load(input: string, opts?: Record<string, unknown>): unknown;
  export = { load };
}
