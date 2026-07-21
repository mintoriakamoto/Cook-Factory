#!/usr/bin/env node
// FF-B02 dogfood check: the fork's OWN operating config must reference ferrox,
// not upstream gsd. Fails (exit 1) while any /gsd- command ref remains in
// .claude/CLAUDE.md or while .planning/config.json branch templates use gsd/.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];

// (1) .claude/CLAUDE.md must contain ZERO "/gsd-" command references.
// Preserve upstream MIT attribution: the repo slug "open-gsd/gsd-core" is not a
// command ref and MUST remain (license attribution). Strip it before scanning.
const claudeMdRaw = fs.readFileSync(path.join(root, '.claude/CLAUDE.md'), 'utf8');
const claudeMd = claudeMdRaw.replace(/open-gsd\/gsd-core/g, 'open-gsd/UPSTREAM');
const gsdCmdRefs = claudeMd.match(/\/gsd-[a-z-]+/g) || [];
if (gsdCmdRefs.length > 0) {
  failures.push(`.claude/CLAUDE.md has ${gsdCmdRefs.length} /gsd- command ref(s): ${[...new Set(gsdCmdRefs)].join(', ')}`);
}
// The gsd-tools.cjs lineage line must be rebranded to ferrox-tools.cjs.
if (/gsd-tools\.cjs/.test(claudeMd)) {
  failures.push('.claude/CLAUDE.md still references gsd-tools.cjs lineage (expected ferrox-tools.cjs)');
}

// (2) .planning/config.json branch + milestone templates must use ferrox/.
const cfg = JSON.parse(fs.readFileSync(path.join(root, '.planning/config.json'), 'utf8'));
for (const key of ['phase_branch_template', 'milestone_branch_template']) {
  const val = (cfg.git && cfg.git[key]) || '';
  if (/^gsd\//.test(val)) {
    failures.push(`.planning/config.json git.${key} still uses gsd/ prefix: "${val}"`);
  } else if (!/^ferrox\//.test(val)) {
    failures.push(`.planning/config.json git.${key} does not use ferrox/ prefix: "${val}"`);
  }
}

if (failures.length > 0) {
  process.stderr.write('FERROX REBRAND CHECK: FAIL\n');
  for (const f of failures) process.stderr.write('  - ' + f + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write('FERROX REBRAND CHECK: PASS (zero /gsd- refs; ferrox/ branch templates)\n');
}
