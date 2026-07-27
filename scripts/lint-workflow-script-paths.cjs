#!/usr/bin/env node
'use strict';

/**
 * lint-workflow-script-paths.cjs — CLI wrapper wiring the #2995 path auditor
 * into lint:ci. audit-workflow-script-paths.cjs is a pure library; until this
 * wrapper existed nothing invoked it, so the exact defect class it was built
 * for (a workflow .md referencing a moved/renamed ${FERROX_HOME} script)
 * could ship silently.
 *
 * installedPrefixes = the top-level dirs the installer stages into the
 * Ferrox install root (see bin/install.js): a workflow may only reference
 * scripts under these.
 */

const path = require('node:path');
const { auditWorkflowScriptPaths } = require('./audit-workflow-script-paths.cjs');
const { runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');
const INSTALLED_PREFIXES = ['ferrox-core', 'hooks', 'scripts'];

runMain(() => {
  const { ok, findings } = auditWorkflowScriptPaths({
    workflowsDir: path.join(ROOT, 'ferrox-core', 'workflows'),
    repoRoot: ROOT,
    installedPrefixes: INSTALLED_PREFIXES,
  });

  if (ok) {
    console.log('ok lint-workflow-script-paths: every ${FERROX_HOME} script reference exists and is installed');
    return 0;
  }
  console.error(`ERROR lint-workflow-script-paths: ${findings.length} finding(s)`);
  for (const f of findings) {
    console.error(`  ${f.workflow}: ${f.path} [${f.kind}]`);
  }
  return 1;
});
