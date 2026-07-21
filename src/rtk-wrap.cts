/**
 * MODEL-05 rtk.wrap decision core.
 *
 * Decide whether a shell/dev op is routed through rtk (the token killer) based on
 * the `model.rtk.enabled` flag AND rtk's presence, with graceful pass-through
 * otherwise so the fork keeps working on a machine without rtk:
 *   - enabled STRICTLY true AND rtkPresent STRICTLY true AND command a non-empty
 *     array of strings -> { decision:'wrap', wrapped:['rtk', ...command] };
 *   - every other case -> { decision:'passthrough', wrapped: command } with the
 *     original command unchanged (T-06-11: never wrap an op the operator disabled,
 *     and never emit a bare 'rtk' with no op).
 *
 * enabled/rtkPresent are EXPLICIT inputs (the Plan 06 router forwards
 * config.model.rtk.enabled; the Plan 06 seam supplies the presence probe).
 * PURE: no fs, no clock, no config, no spawn.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/rtk-wrap.cjs. `export =` CJS shape; no stdout.
 */

interface RtkWrapResult {
  decision: 'wrap' | 'passthrough';
  wrapped: unknown;
}

/**
 * PURE. Decide wrap vs passthrough for a shell/dev command.
 *
 * Fails closed to passthrough on any non-strict flag, absent rtk, or an
 * empty/non-array/non-string command.
 */
function evaluateRtkWrap(opts: {
  enabled?: unknown;
  rtkPresent?: unknown;
  command?: unknown;
}): RtkWrapResult {
  const enabled = opts ? opts.enabled : undefined;
  const rtkPresent = opts ? opts.rtkPresent : undefined;
  const command = opts ? opts.command : undefined;

  // Inline the checks so TypeScript narrows `command` to an array for the spread —
  // no cast needed. Fails closed to passthrough on any non-strict flag, absent
  // rtk, or an empty/non-array/non-string command.
  if (
    enabled === true &&
    rtkPresent === true &&
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((c) => typeof c === 'string')
  ) {
    return { decision: 'wrap', wrapped: ['rtk', ...command] };
  }
  // Graceful pass-through: original command unchanged (whatever was passed).
  return { decision: 'passthrough', wrapped: command };
}

export = { evaluateRtkWrap };
