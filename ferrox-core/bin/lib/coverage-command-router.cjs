"use strict";
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
const command_aliases_cjs_1 = require("./command-aliases.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cjsCommandRouterAdapter = require("./cjs-command-router-adapter.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const coverageDelta = require("./coverage-delta.cjs");
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
function parseFlag(args, flag) {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function handleDelta(args, raw, error) {
    const beforeRaw = parseFlag(args, '--before');
    const afterRaw = parseFlag(args, '--after');
    const before = Number(beforeRaw);
    const after = Number(afterRaw);
    if (beforeRaw === undefined || afterRaw === undefined ||
        !Number.isFinite(before) || !Number.isFinite(after)) {
        error('Usage: ferrox-tools query coverage.delta --before <n> --after <n>');
        return;
    }
    const result = coverageDelta.evaluateCoverageDelta(before, after);
    process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}
function routeCoverageCommand({ args, raw, error }) {
    routeCjsCommandFamily({
        args,
        subcommands: command_aliases_cjs_1.COVERAGE_SUBCOMMANDS,
        unsupported: {},
        error,
        unknownMessage: (_s, available) => `Unknown coverage subcommand. Available: ${available.join(', ')}`,
        handlers: {
            delta: () => handleDelta(args, raw, error),
        },
    });
}
module.exports = { routeCoverageCommand };
