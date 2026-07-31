/**
 * Fleet capability: activation, interpreter probe, engine presence, readiness.
 *
 * Phase 18 plan 02. The vendored engine lives under
 * `ferrox-core/bin/vendor/ratchet/`. This module is the 1 place that decides
 * whether it is on, whether it would work, and what the doctor says about it.
 *
 * 3 properties are load bearing and each is asserted by a committed test.
 *
 * 1. Activation delegates to `resolveConfigKey`, the 1 precedence chain the
 *    capability state resolver already uses. A second resolver here could
 *    disagree with the first, and then the doctor line and the readiness verdict
 *    would be answering different questions.
 *
 * 2. The interpreter probe is a LOOKUP. Nothing is executed. The precedent is
 *    `hasOnPath` in src/anvil-executor.cts, and the reasons are that the doctor
 *    runs often so an exec per run is a cost nobody asked for, and that
 *    executing a binary found on an arbitrary PATH is an execution surface a
 *    lookup does not have. The interpreter version is established once, by the
 *    vendor drop's compile check, and recorded there.
 *
 * 3. `formatFleetDoctorLine` returns null when the capability is inactive. An
 *    inactive capability contributes NO line, rather than a line that says
 *    nothing. That is structural: a future edit which leaks readiness into the
 *    inactive arm has to delete the null branch, and deleting it breaks a
 *    committed test.
 */

import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import activationMod = require('./capability-activation.cjs');
const { resolveConfigKey } = activationMod as {
  resolveConfigKey(
    this: void,
    dotKey: string,
    opts: { config: Record<string, unknown>; cwd: string | undefined; registry: Record<string, unknown> },
  ): { found: boolean; value: unknown };
};

/** The dotted activation key. Declared in capabilities/fleet/capability.json. */
const FLEET_ACTIVATION_KEY = 'fleet.enabled';

/** The interpreter the vendored engine's shebang names. */
const FLEET_INTERPRETER = 'python3';

/** The count of entrypoints the vendor drop pinned. Presence below this is a partial tree. */
const EXPECTED_ENTRYPOINTS = 15;

interface InterpreterProbe {
  found: boolean;
  name: string;
  path: string | null;
}

interface EngineProbe {
  found: boolean;
  dir: string;
  entrypoints: number;
}

interface FleetReadiness {
  active: boolean;
  ready: boolean | null;
  reason: string | null;
  interpreter: InterpreterProbe | null;
  engine: EngineProbe | null;
}

/**
 * PURE over its inputs. True when the activation key resolves truthy through the
 * shared 4 level precedence walk, false when it resolves falsy, false when it is
 * absent everywhere.
 */
function isFleetActive(opts: {
  config?: Record<string, unknown>;
  cwd?: string | undefined;
  registry?: Record<string, unknown>;
}): boolean {
  const config = opts.config || {};
  const registry = opts.registry || {};
  try {
    const r = resolveConfigKey(FLEET_ACTIVATION_KEY, { config, cwd: opts.cwd, registry });
    return r.found ? Boolean(r.value) : false;
  } catch {
    return false;
  }
}

/**
 * LOOKUP ONLY. Nothing is executed. `pathEnv` and `interpreter` are injected so
 * a test can drive the absent arm without mutating the process environment,
 * which is the only way the absent arm can be observed on a machine that has an
 * interpreter.
 */
function probeInterpreter(opts?: { pathEnv?: string; interpreter?: string }): InterpreterProbe {
  const name = (opts && opts.interpreter) || FLEET_INTERPRETER;
  const pathEnv = opts && typeof opts.pathEnv === 'string' ? opts.pathEnv : (process.env.PATH || '');
  if (path.isAbsolute(name)) {
    try {
      return fs.existsSync(name)
        ? { found: true, name, path: name }
        : { found: false, name, path: null };
    } catch {
      return { found: false, name, path: null };
    }
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate)) return { found: true, name, path: candidate };
    } catch {
      /* an unreadable PATH entry is not an error, it is just not a hit */
    }
  }
  return { found: false, name, path: null };
}

/** The vendored engine directory, resolved from this module's own location. */
function defaultEngineDir(): string {
  return path.join(__dirname, '..', 'vendor', 'ratchet', 'bin');
}

/**
 * COUNTS entrypoints. A presence check on the directory passes on an empty
 * directory, so the count is the claim and the expected count is named.
 */
function probeEngine(opts?: { engineDir?: string }): EngineProbe {
  const dir = (opts && opts.engineDir) || defaultEngineDir();
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).length;
    return { found: files >= EXPECTED_ENTRYPOINTS, dir, entrypoints: files };
  } catch {
    return { found: false, dir, entrypoints: 0 };
  }
}

/**
 * The readiness assembler. Inactive short circuits BEFORE either probe runs, so
 * an inactive capability costs a doctor run nothing and carries no verdict at
 * all rather than a verdict nobody asked for.
 */
function assessFleetReadiness(opts: {
  config?: Record<string, unknown>;
  cwd?: string | undefined;
  registry?: Record<string, unknown>;
  pathEnv?: string;
  interpreter?: string;
  engineDir?: string;
}): FleetReadiness {
  const active = isFleetActive({ config: opts.config, cwd: opts.cwd, registry: opts.registry });
  if (!active) {
    return { active: false, ready: null, reason: null, interpreter: null, engine: null };
  }
  const engine = probeEngine({ engineDir: opts.engineDir });
  const interpreter = probeInterpreter({ pathEnv: opts.pathEnv, interpreter: opts.interpreter });
  if (!engine.found) {
    return {
      active: true,
      ready: false,
      reason: `the vendored engine is missing or incomplete at ${engine.dir} (${engine.entrypoints} of ${EXPECTED_ENTRYPOINTS} entrypoints)`,
      interpreter,
      engine,
    };
  }
  if (!interpreter.found) {
    return {
      active: true,
      ready: false,
      reason: `${interpreter.name} is not on PATH`,
      interpreter,
      engine,
    };
  }
  return { active: true, ready: true, reason: null, interpreter, engine };
}

/**
 * PURE over a readiness object. Returns null for EVERY inactive case, and a
 * single line string for every active case. Assert `=== null` rather than
 * falsy, so an empty string can never pass for a suppressed line.
 */
function formatFleetDoctorLine(readiness: FleetReadiness | null | undefined): string | null {
  if (!readiness || !readiness.active) return null;
  if (readiness.ready === true) {
    const interp = readiness.interpreter;
    const engine = readiness.engine;
    const where = interp && interp.path ? interp.path : (interp ? interp.name : FLEET_INTERPRETER);
    const count = engine ? engine.entrypoints : 0;
    return `fleet: READY (${where}, ${count} vendored entrypoints)`;
  }
  return `fleet: NOT READY (${readiness.reason || 'unknown reason'})`;
}

export = {
  FLEET_ACTIVATION_KEY,
  FLEET_INTERPRETER,
  EXPECTED_ENTRYPOINTS,
  isFleetActive,
  probeInterpreter,
  probeEngine,
  defaultEngineDir,
  assessFleetReadiness,
  formatFleetDoctorLine,
};
