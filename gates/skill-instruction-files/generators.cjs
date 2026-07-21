'use strict';
/**
 * Fluent fixture generators for the skill-instruction-files gate (v1.9 Wave 4, pack A).
 *
 * ADR-SEALED-GATES: fixture CONTENT never enters the repo. Only these generators are
 * committed; the orchestrator (and the test suite) calls them, seals the emitted content
 * into the sealed store, and fills the card's `sealed:sha256:` references at seal time.
 * Every emission carries a per-seal nonce (a codename token woven into the text), so
 * sealed instances differ per machine and can never hash-collide with a repo blob.
 *
 * Pool (5 mutants, all fluent-but-wrong):
 *   sk-m1  references 1 renamed script path that reads plausibly    must_fail SK-01
 *   sk-m2  40 percent over token budget via polite padding          must_fail SK-02
 *   sk-m3  runnable bash example calling a nonexistent flag         must_fail SK-03
 *   sk-m4  contradictory directives 200+ lines apart                must_fail SK-05
 *   sk-m5  valid structure but empty description                    must_fail SK-04
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GATE_ID = 'skill-instruction-files';
/** Budget the card invocation declares. sk-m2 pads 40 percent past it. */
const BUDGET_TOKENS = 2600;
const CHARS_PER_TOKEN = 3.6;

function mintNonce() {
  return crypto.randomBytes(4).toString('hex');
}

/** The workspace the reference file instructs over. Paths here must resolve. */
function buildWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo workspace\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'run-check.cjs'), "console.log('check ok');\n");
  fs.writeFileSync(path.join(dir, 'docs', 'setup.md'), '# setup\n\nInstall node 20 or newer.\n');
  return dir;
}

/** The tool and skill manifest SK-01 resolves names against. */
function manifest() {
  return {
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    skills: ['ferrox-quick', 'ferrox-debug', 'ferrox-verify-work'],
  };
}

function writeManifest(file) {
  fs.writeFileSync(file, JSON.stringify(manifest(), null, 2) + '\n');
  return file;
}

function referenceLines(nonce) {
  return [
    '---',
    'name: workspace-verify',
    'description: Verify the project workspace layout, tool wiring, and setup docs before a release increment lands on main.',
    'allowed-tools: [Read, Bash]',
    '---',
    '',
    '# Workspace verify',
    '',
    `Codename for this batch: rx-${nonce}.`,
    '',
    'Run the check script and confirm the setup doc matches the tree it describes.',
    '',
    '## Steps',
    '',
    '1. Read `docs/setup.md` and confirm the runtime floor it states.',
    '2. Run the check script `scripts/run-check.cjs`:',
    '',
    '```bash',
    'node scripts/run-check.cjs --report',
    '```',
    '',
    '3. Confirm the sandbox echo works end to end:',
    '',
    '```bash runnable',
    "printf 'workspace %s ok\\n' 'core'",
    '```',
    '',
    '4. For anything that fails, hand off with `/ferrox-debug` and stop.',
    '',
    '## Rules',
    '',
    '- Never auto-commit while a check is red.',
    '- Keep every report under 120 lines and lead with the verdict.',
    '- Use digits in counts and dates; keep prose plain.',
    '',
  ];
}

function joinLines(lines) {
  return lines.join('\n') + '\n';
}

function referenceContent(opts) {
  const nonce = opts && typeof opts.nonce === 'string' ? opts.nonce : mintNonce();
  return joinLines(referenceLines(nonce));
}

function politePadding(count) {
  const lines = [];
  for (let i = 1; i <= count; i++) {
    lines.push(
      `Please also take a moment, when convenient, to appreciate consideration ${i}: ` +
        'a careful reviewer will thank you for keeping this workflow gentle, thorough, ' +
        'and unhurried, because clarity is a gift we give to whoever reads this file next.'
    );
    lines.push('');
  }
  return lines;
}

function mutants(opts) {
  const nonce = opts && typeof opts.nonce === 'string' ? opts.nonce : mintNonce();
  const base = referenceLines(nonce);

  // sk-m1: the check script gains a plausible plural. The path no longer exists.
  const m1 = base.map((l) => l.replace('scripts/run-check.cjs', 'scripts/run-checks.cjs'));

  // sk-m2: pad politely until the estimated token count sits 40 percent over budget.
  const targetChars = Math.ceil(BUDGET_TOKENS * CHARS_PER_TOKEN * 1.45);
  const m2 = [...base, '## Appendix: reviewer courtesy notes', ''];
  while (joinLines(m2).length < targetChars) {
    m2.push(...politePadding(4));
  }

  // sk-m3: a runnable example whose flag does not exist. Syntax-clean, exits nonzero.
  const m3 = [
    ...base,
    '## Deep listing',
    '',
    'For the long-form report, include the frobnicated depth listing:',
    '',
    '```bash runnable',
    'ls --frobnicate-depth=3',
    '```',
    '',
  ];

  // sk-m4: directive A near the top, directive B 200+ lines later. Each side reads fine.
  const filler = [];
  for (let i = 1; i <= 105; i++) {
    filler.push(`- Note ${String(i).padStart(3, '0')}: keep the entry short.`);
    filler.push('');
  }
  const m4 = [
    ...base.slice(0, 5),
    '',
    '# Climb loop rules',
    '',
    'Never auto-commit while the climb loop is open.',
    '',
    '## Operating notes',
    '',
    ...filler,
    '## Wrap up',
    '',
    'When the climb completes, always auto-commit the verified results.',
    '',
  ];

  // sk-m5: structurally valid frontmatter, description left empty.
  const m5 = base.map((l) => (l.startsWith('description:') ? 'description: ""' : l));

  return [
    {
      id: 'sk-m1',
      whyFluent: 'references scripts/run-checks.cjs, a plausible plural of the real script; reads correct at a skim',
      expectedDrop: 1,
      mustFail: ['SK-01'],
      content: joinLines(m1),
    },
    {
      id: 'sk-m2',
      whyFluent: '40 percent over token budget through polite reviewer-courtesy padding; every paragraph reads professional',
      expectedDrop: 1,
      mustFail: ['SK-02'],
      content: joinLines(m2),
    },
    {
      id: 'sk-m3',
      whyFluent: 'runnable bash example calls ls with a flag that does not exist; syntax-clean and plausible to a skim',
      expectedDrop: 1,
      mustFail: ['SK-03'],
      content: joinLines(m3),
    },
    {
      id: 'sk-m4',
      whyFluent: 'forbids auto-commit up top and mandates it 200+ lines later; each directive reads sane in isolation',
      expectedDrop: 1,
      mustFail: ['SK-05'],
      content: joinLines(m4),
    },
    {
      id: 'sk-m5',
      whyFluent: 'frontmatter is structurally valid so schema-shape scanners pass; the description is an empty string',
      expectedDrop: 1,
      mustFail: ['SK-04'],
      content: joinLines(m5),
    },
  ];
}

/** Assemble a concrete card at seal time: real sealed URIs drop into the committed shape. */
function cardMarkdown(args) {
  const rotationK = args && Number.isFinite(args.rotationK) ? args.rotationK : 2;
  const mutantYaml = args.mutants
    .map(
      (m) =>
        `    - { id: ${m.id}, class: fluent-but-wrong, why_fluent: ${m.whyFluent}, ` +
        `expected_drop: ${m.expectedDrop}, must_fail: [${m.mustFail.join(', ')}], fixture: ${m.fixtureUri} }`
    )
    .join('\n');
  return [
    '---',
    'card: 1',
    `gate_id: ${GATE_ID}`,
    'domain: agent-ops',
    'tier: 1',
    'relational_target:',
    '  artifact: the workspace tree and tool/skill manifest the file instructs over',
    '  relation: every referenced path, tool, and skill resolves against it',
    'disclosure_default: opaque',
    'checks:',
    '  - { id: SK-01, category: grounding, desc: no dead references, measures: path/tool/skill resolution vs workspace and manifest }',
    '  - { id: SK-02, category: value, desc: token budget respected, measures: ceil(chars/3.6) <= declared budget }',
    '  - { id: SK-03, category: execution, desc: bash examples work, measures: bash -n on all blocks and exit 0 for runnable blocks in a sandbox }',
    '  - { id: SK-04, category: structure, desc: frontmatter schema valid, measures: name present and description >= 40 chars }',
    '  - { id: SK-05, category: relation, desc: no contradictory directives, measures: declared exclusive pattern pairs must not both match }',
    '  - { id: SK-06, category: value, desc: editorial floor holds, measures: no em dash and digits not words before countable nouns }',
    'wrapped_tools:',
    '  - { name: node, version: 20.20.2, license: MIT, role: gate runtime }',
    '  - { name: bash, version: 3.2.57, license: GPL-2.0-only, role: example syntax check and sandbox execution }',
    'validation:',
    `  reference: ${args.referenceUri}`,
    '  pool_min: 5',
    '  pool_status: full',
    '  mutants:',
    mutantYaml,
    `  rotation_k: ${rotationK}`,
    '  last_validated: null',
    'gamed_modes:',
    '  - { mode: reference-sparse file that mentions nothing resolvable, status: crucible, note: SK-01 is permissive on sparse files by design; reference completeness is a spec-review judgment }',
    '  - { mode: marking every bash example non-runnable, status: mitigated, note: the task spec for this gate requires at least 1 runnable example; the gate hard-fails runnable ones }',
    '  - { mode: lexical satisfaction of named FAIL strings, status: sealed, note: opaque ids plus rotating fluent mutant pool }',
    '---',
    '',
    '## Intent',
    'Prove the operator artifact class that rots silently (SKILL.md, CLAUDE.md, AGENTS.md,',
    'system prompts) resolves, fits its budget, executes, and does not contradict itself.',
    '',
    '## Gamed-mode rationale',
    'Sparse files dodge the dead-ref scan; that judgment slice routes to spec review.',
    '',
    '## Change log',
    '- 2026-07-21 authored in Wave 4 with the sealed fluent pool.',
    '',
  ].join('\n');
}

module.exports = {
  GATE_ID,
  BUDGET_TOKENS,
  mintNonce,
  buildWorkspace,
  manifest,
  writeManifest,
  referenceContent,
  mutants,
  cardMarkdown,
};
