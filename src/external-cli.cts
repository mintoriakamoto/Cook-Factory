/**
 * MODEL-04/05 external-CLI seam — the ONE impure subprocess boundary.
 *
 * Every real codex/gemini/rtk invocation crosses THIS seam and no other. It is
 * pure-by-injection: when a `run` function is supplied (unit tests) it is called
 * instead of spawning, so the required suite never spawns a real process; when it
 * is absent the seam spawns via child_process.spawnSync with an ARGV ARRAY and
 * `shell:false` — never a shell string, so codex/gemini/rtk args are never
 * shell-interpolated (injection defense, T-06-02).
 *
 * Contract:
 *   - runs the bin EXACTLY ONCE per call — no retry loop (the anti-loop thesis
 *     extends to the seam);
 *   - carries a bounded timeout so a hung external CLI cannot stall the seam
 *     (T-06-15);
 *   - on ENOENT / timeout / any spawn error returns `{ present:false }` and NEVER
 *     throws — graceful degrade so the fork keeps working when a CLI is absent;
 *   - on a real run returns `{ present:true, code, stdout, stderr }`.
 *
 * The injected `run` is a drop-in for spawnSync: it receives `(bin, args, options)`
 * and returns a spawnSync-shaped `{ status, stdout, stderr, error }`, so the result
 * shaping below is identical for the real and injected paths.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/external-cli.cjs. `export =` CJS shape.
 */

// Namespace import (not destructured) so the default spawn reference is resolved
// at call time — mirrors shell-command-projection's mockability rationale.
import childProcess from 'node:child_process';

/** A spawnSync-shaped result: the injected `run` returns this exact shape. */
interface SpawnLikeResult {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: (Error & { code?: string }) | null;
  signal?: NodeJS.Signals | null;
}

/** A spawnSync-drop-in runner (real: childProcess.spawnSync; test: an injection). */
type SpawnLikeRunner = (bin: string, args: string[], options: Record<string, unknown>) => SpawnLikeResult;

type ExternalCliResult =
  | { present: false }
  | { present: true; code: number | null; stdout: string; stderr: string };

/** The default bounded timeout for an external CLI call. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Invoke an external CLI across the single impure boundary. Pure-by-injection,
 * argv-safe (shell:false), single-shot (no retry), and never-throwing.
 */
function runExternalCli(opts: {
  bin?: unknown;
  args?: unknown;
  cwd?: unknown;
  timeoutMs?: unknown;
  run?: unknown;
}): ExternalCliResult {
  const bin = opts && typeof opts.bin === 'string' ? opts.bin : '';
  if (bin === '') return { present: false };

  const args = opts && Array.isArray(opts.args) ? (opts.args as string[]) : [];
  const cwd = opts && typeof opts.cwd === 'string' ? opts.cwd : undefined;
  const timeout = opts && typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
    ? opts.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const runner: SpawnLikeRunner = typeof (opts ? opts.run : undefined) === 'function'
    ? (opts.run as SpawnLikeRunner)
    : childProcess.spawnSync;

  let result: SpawnLikeResult;
  try {
    // ARGV ARRAY + shell:false — never a shell string (injection defense). Runs
    // exactly ONCE; no surrounding retry loop.
    result = runner(bin, args, {
      shell: false,
      cwd,
      timeout,
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch {
    // Defensive: spawnSync is not expected to throw, but any throw degrades
    // gracefully rather than propagating out of the seam.
    return { present: false };
  }

  // ENOENT / timeout (ETIMEDOUT) / any spawn error → absent, graceful degrade.
  if (!result || result.error) return { present: false };

  return {
    present: true,
    code: result.status ?? null,
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
  };
}

export = { runExternalCli };
