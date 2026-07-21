/**
 * HALT-04 coverage.delta CLI router (Plan 06, D-02).
 *
 * Exposes the tested coverage-delta core (Plan 05) as
 * `ferrox_run query coverage.delta`. PURE arithmetic — no config, no .planning
 * access (coverage is in SKIP_ROOT_RESOLUTION). Forwards --before/--after to the
 * core and writes the decision JSON to stdout: a strictly positive delta is
 * `landed`; a zero (no-op) or negative delta is `not-landed`.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/coverage-command-router.cjs.
 */

import { COVERAGE_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coverageDelta = require('./coverage-delta.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;

interface RouteCoverageCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function handleDelta(args: string[], raw: boolean, error: (m: string, r?: string) => void): void {
  const beforeRaw = parseFlag(args, '--before');
  const afterRaw = parseFlag(args, '--after');

  const before = Number(beforeRaw);
  const after = Number(afterRaw);

  if (
    beforeRaw === undefined || afterRaw === undefined ||
    !Number.isFinite(before) || !Number.isFinite(after)
  ) {
    error('Usage: ferrox-tools query coverage.delta --before <n> --after <n>');
    return;
  }

  const result = coverageDelta.evaluateCoverageDelta(before, after);

  process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}

function routeCoverageCommand({ args, raw, error }: RouteCoverageCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: COVERAGE_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_s: string, available: string[]) => `Unknown coverage subcommand. Available: ${available.join(', ')}`,
    handlers: {
      delta: () => handleDelta(args, raw, error),
    },
  });
}

export = { routeCoverageCommand };
