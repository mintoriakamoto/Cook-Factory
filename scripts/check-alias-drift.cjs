'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const aliasesPath = path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'command-aliases.cjs');

function fail(message) {
  process.stderr.write(`${message}\n`);
  throw new ExitError(1);
}

function ensureArray(value, name) {
  if (!Array.isArray(value)) {
    fail(`check:alias-drift: expected ${name} to be an array`);
  }
}

function assertNoDuplicates(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      fail(`check:alias-drift: duplicate ${label} value "${value}"`);
    }
    seen.add(value);
  }
}

function main() {
  if (!fs.existsSync(aliasesPath)) {
    fail(`check:alias-drift: missing ${path.relative(ROOT, aliasesPath)}`);
  }

  const aliases = require(aliasesPath);

  const families = [
    {
      commandAliases: 'STATE_COMMAND_ALIASES',
      subcommands: 'STATE_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'state-command-router.cjs'),
    },
    {
      commandAliases: 'VERIFY_COMMAND_ALIASES',
      subcommands: 'VERIFY_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'verify-command-router.cjs'),
    },
    {
      commandAliases: 'INIT_COMMAND_ALIASES',
      subcommands: 'INIT_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'init-command-router.cjs'),
    },
    {
      commandAliases: 'PHASE_COMMAND_ALIASES',
      subcommands: 'PHASE_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'phase-command-router.cjs'),
    },
    {
      commandAliases: 'PHASES_COMMAND_ALIASES',
      subcommands: 'PHASES_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'phases-command-router.cjs'),
    },
    {
      commandAliases: 'VALIDATE_COMMAND_ALIASES',
      subcommands: 'VALIDATE_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'validate-command-router.cjs'),
    },
    {
      commandAliases: 'ROADMAP_COMMAND_ALIASES',
      subcommands: 'ROADMAP_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'roadmap-command-router.cjs'),
    },
    {
      commandAliases: 'EVAL_COMMAND_ALIASES',
      subcommands: 'EVAL_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'eval-command-router.cjs'),
    },
    {
      commandAliases: 'GATE_COMMAND_ALIASES',
      subcommands: 'GATE_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'gate-command-router.cjs'),
    },
    {
      commandAliases: 'RESCOPE_COMMAND_ALIASES',
      subcommands: 'RESCOPE_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'rescope-command-router.cjs'),
    },
    {
      commandAliases: 'HUMAN_SLA_COMMAND_ALIASES',
      subcommands: 'HUMAN_SLA_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'human-sla-command-router.cjs'),
    },
    {
      commandAliases: 'SHIP_CLOCK_COMMAND_ALIASES',
      subcommands: 'SHIP_CLOCK_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'ship-clock-command-router.cjs'),
    },
    {
      commandAliases: 'COVERAGE_COMMAND_ALIASES',
      subcommands: 'COVERAGE_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'coverage-command-router.cjs'),
    },
    {
      commandAliases: 'COORD_COMMAND_ALIASES',
      subcommands: 'COORD_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'coord-command-router.cjs'),
    },
    {
      commandAliases: 'STRENGTH_COMMAND_ALIASES',
      subcommands: 'STRENGTH_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'strength-command-router.cjs'),
    },
    {
      commandAliases: 'MODEL_COMMAND_ALIASES',
      subcommands: 'MODEL_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'model-command-router.cjs'),
    },
    {
      commandAliases: 'TRIDENT_COMMAND_ALIASES',
      subcommands: 'TRIDENT_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'trident-command-router.cjs'),
    },
    {
      commandAliases: 'RTK_COMMAND_ALIASES',
      subcommands: 'RTK_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'rtk-command-router.cjs'),
    },
    {
      commandAliases: 'MEMORY_COMMAND_ALIASES',
      subcommands: 'MEMORY_SUBCOMMANDS',
      routerPath: path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'memory-command-router.cjs'),
    },
  ];

  for (const family of families) {
    const commandAliases = aliases[family.commandAliases];
    const subcommands = aliases[family.subcommands];

    ensureArray(commandAliases, family.commandAliases);
    ensureArray(subcommands, family.subcommands);

    const derivedSubcommands = commandAliases.map((entry) => entry && entry.subcommand);
    assertNoDuplicates(derivedSubcommands, `${family.commandAliases}.subcommand`);

    if (derivedSubcommands.length !== subcommands.length) {
      fail(
        `check:alias-drift: ${family.subcommands} length ${subcommands.length} does not match ` +
        `${family.commandAliases} length ${derivedSubcommands.length}`,
      );
    }

    for (let i = 0; i < derivedSubcommands.length; i++) {
      if (derivedSubcommands[i] !== subcommands[i]) {
        fail(
          `check:alias-drift: ${family.subcommands}[${i}] = "${subcommands[i]}" ` +
          `does not match ${family.commandAliases}[${i}].subcommand = "${derivedSubcommands[i]}"`,
        );
      }
    }

    const routerSource = fs.readFileSync(family.routerPath, 'utf8');
    if (!routerSource.includes(family.subcommands)) {
      fail(
        `check:alias-drift: ${path.relative(ROOT, family.routerPath)} does not reference ${family.subcommands}`,
      );
    }
  }

  process.stdout.write('check:alias-drift ok\n');
}

runMain(main);
