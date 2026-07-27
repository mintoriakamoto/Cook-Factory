'use strict';

/**
 * Gate predicate evaluator — env-based context hardening (ADR-2008).
 *
 * ${PHASE_*} context used to be textually spliced into the `sh -c` command
 * string, so a hostile value arriving through the CLI flags (e.g.
 * `--phase-req-ids '; rm -rf .'`) would have been executed as shell syntax.
 * The evaluator now passes context as ENVIRONMENT variables and lets sh expand
 * `${PHASE_DIR}`-style references itself — values stay data no matter their
 * content. This suite pins both the seam contract (env reaches the deps) and
 * the end-to-end sh behavior (expansion works; injection is inert).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const {
  evaluatePredicate,
  buildPredicateEnv,
  INTERPOLATION_VAR_NAMES,
} = require('../ferrox-core/bin/lib/gate-predicate-evaluator.cjs');

const CTX = { cwd: '.', phaseNumber: '3', phaseDir: 'phases/03', phaseReqIds: 'REQ-1; rm -rf .' };

test('buildPredicateEnv exports exactly the declared variables, undefined => empty', () => {
  assert.deepEqual(buildPredicateEnv(CTX), {
    PHASE_NUMBER: '3',
    PHASE_DIR: 'phases/03',
    PHASE_REQ_IDS: 'REQ-1; rm -rf .',
  });
  assert.deepEqual(Object.keys(buildPredicateEnv({ cwd: '.' })).sort(), [...INTERPOLATION_VAR_NAMES].sort());
  assert.equal(buildPredicateEnv({ cwd: '.' }).PHASE_DIR, '');
});

test('the command string reaches the shell seam UNMODIFIED, with context in env', () => {
  let seen = null;
  const deps = {
    runBoundedShell(opts) {
      seen = opts;
      return { exitCode: 0, stdout: '', stderr: '', signal: null, timedOut: false };
    },
  };
  const r = evaluatePredicate(
    { kind: 'command-exit-zero', command: 'check-phase "${PHASE_DIR}"' }, CTX, deps,
  );
  assert.equal(r.block, false);
  assert.equal(seen.command, 'check-phase "${PHASE_DIR}"', 'no textual interpolation into the command');
  assert.equal(seen.env.PHASE_DIR, 'phases/03');
  assert.equal(seen.env.PHASE_REQ_IDS, 'REQ-1; rm -rf .');
});

test('end-to-end sh: ${PHASE_*} expands from env and a hostile value stays inert data', () => {
  const env = { ...process.env, ...buildPredicateEnv(CTX) };
  // sh expands ${PHASE_REQ_IDS} itself; the embedded `; rm -rf .` is DATA in
  // a variable, not shell syntax — the comparison sees the literal string.
  const out = execFileSync(
    'sh', ['-c', 'test "${PHASE_REQ_IDS}" = "REQ-1; rm -rf ." && echo "inert:${PHASE_DIR}"'],
    { env, encoding: 'utf8' },
  );
  assert.equal(out.trim(), 'inert:phases/03');
});
