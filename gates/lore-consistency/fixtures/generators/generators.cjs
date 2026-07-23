'use strict';
/**
 * Fluent fixture generators for the lore-consistency gate (v1.13 Wave 3).
 *
 * ADR-SEALED-GATES: fixture CONTENT never enters the repo. Only these generators are
 * committed; the operator machine (and the test suite) calls them, seals the emitted
 * bundles into the sealed store, and fills the card's `sealed:sha256:` references at
 * seal time. Every emission weaves a per-seal nonce into the chapter body (a lowercase
 * door-code token), so sealed instances differ per machine and can never hash-collide
 * with a repo blob.
 *
 * Each fixture is 1 complete orchestrator-built JSON bundle
 * (schema ferrox.lore-consistency.bundle/1): chapter + lore + trusted_contract +
 * prior_state + thresholds. The reference bundle scores 9/9. The 6 mutants are all
 * fluent-but-wrong, seeded from the continuity prior-art research:
 *
 *   lc-m1  ghost scene via nudged date; lifecycle passes, monotone catches   must_fail LC-05
 *   lc-m2  dead character on stage, warmly greeted                           must_fail LC-04
 *   lc-m3  required-cast name homoglyphed; reader sees it, matcher cannot    must_fail LC-03
 *   lc-m4  flashback flag lying; the date lands AFTER the previous chapter   must_fail LC-05
 *   lc-m5  off-by-one age at a birthday boundary (year subtraction trap)     must_fail LC-06
 *   lc-m6  closed thread touched again; the callback line reads like craft   must_fail LC-08
 */

const crypto = require('node:crypto');

const GATE_ID = 'lore-consistency';

/** Cyrillic small o, escape-spelled: the homoglyph lc-m3 threads into a Latin name. */
const HOMOGLYPH_O = 'о';

function mintNonce() {
  return crypto.randomBytes(4).toString('hex');
}

/** Mirror of the gate's word-count rule: whitespace-delimited tokens of the body. */
function wordCount(body) {
  return body.split(/\s+/).filter((t) => t !== '').length;
}

/** The LORE.md store the bundle carries: prose around 1 fenced canon-facts block. */
function loreMarkdown() {
  return [
    '# LORE: The Vault Heist',
    '',
    'Working bible for the Veyra Bank heist novella. The prose around the fence is',
    'human-owned; the fenced canon-facts block below is the machine slice the keeper',
    'owns and the lore-consistency gate consumes.',
    '',
    '```yaml canon-facts',
    'schema: canon-facts/v1',
    'store: lore',
    'entities:',
    '  - id: mara-vale',
    '    type: character',
    '    name: Mara Vale',
    '    aliases: [The Locksmith]',
    '    status: alive',
    '    birthdate: 2102-03-18',
    '    introduced: ch-cold-open:12',
    '    facts:',
    '      - { key: eye_color, value: green, provenance: ch-cold-open:15 }',
    '  - id: dorian-ash',
    '    type: character',
    '    name: Dorian Ash',
    '    aliases: []',
    '    status: alive',
    '    birthdate: 2099-11-02',
    '    introduced: ch-cold-open:44',
    '  - id: silas-crane',
    '    type: character',
    '    name: Silas Crane',
    '    aliases: [The Broker]',
    '    status: dead',
    '    birthdate: 2074-06-30',
    '    death_date: 2131-02-09',
    '    introduced: ch-cold-open:63',
    '  - id: wren-tam',
    '    type: character',
    '    name: Wren Tam',
    '    aliases: []',
    '    status: departed',
    '    introduced: ch-cold-open:52',
    '  - id: veyra-bank',
    '    type: place',
    '    name: The Veyra Bank',
    '    aliases: [the Vault]',
    '    status: alive',
    '    introduced: ch-cold-open:5',
    '  - id: night-ledger',
    '    type: prop',
    '    name: the Night Ledger',
    '    aliases: []',
    '    status: alive',
    '    introduced: ch-cold-open:70',
    'timeline:',
    '  - { date: 2131-02-09, event: Silas Crane dies in the flood market, provenance: ch-flood-market:88 }',
    'threads:',
    '  - { id: heist-plan, status: open }',
    '  - { id: crane-debt, status: open }',
    '  - { id: vault-echo, status: open }',
    '  - { id: cold-open-tail, status: closed, closed: ch-flood-market:120 }',
    '```',
    '',
    '## Revisions',
    '',
    '- ch-cold-open ingested; ch-flood-market ingested.',
    '',
  ].join('\n');
}

/** The chapter body: fluent prose, canon names intact, the nonce woven in lowercase. */
function chapterBody(nonce) {
  return [
    'The rain had given up by the time Mara Vale reached the service door of the',
    'Veyra Bank, and the cameras had not. She counted 11 live feeds on the north',
    `face, logged the 2 dark ones, and keyed the door code, rx-${nonce}, into the`,
    'brass panel the way the Locksmith always did: without looking at her hands.',
    '',
    'Dorian Ash was waiting in the counting room with his coat still dripping. He',
    'had the Night Ledger open on the table, spine cracked to the page she had paid',
    'for, and he did not look up when she came in. "You are late," he said. "The',
    'vault rotates its permissions at midnight. We hold the window until then."',
    '',
    '"We hold it until the auditors wake," she said. "That is closer."',
    '',
    "They worked the pages in silence. Crane's debt was written there in 3",
    'different hands, and the debt had outlived the man who carried it; she felt',
    'the old obligation settle on her shoulders like wet rope. Whatever the vault',
    'held, the Night Ledger held the reason, and the reason had her name in it.',
    '',
    'When the bells rang the half hour, Dorian Ash closed the book and looked at',
    'her at last. "The approach is clean," he said. "Service corridor, then the',
    'east stair. Nobody walks the stair after the shift turns."',
    '',
    'She nodded, folded the page into memory, and let the plan take its final',
    'shape. The vault would open for them or it would not. The ledger said it',
    'would.',
    '',
  ].join('\n');
}

/** Assemble the draft chapter markdown: contract echo frontmatter + the body. */
function chapterMarkdown(fm, body) {
  const lines = [
    '---',
    `chapter_id: ${fm.chapter_id}`,
    `pov: ${fm.pov}`,
    `scene_date: ${fm.scene_date}`,
    `location: ${fm.location}`,
    `flashback: ${fm.flashback}`,
    'threads:',
    `  touch: [${fm.threads.touch.join(', ')}]`,
    `  open: [${fm.threads.open.join(', ')}]`,
    `  close: [${fm.threads.close.join(', ')}]`,
    `required_on_stage: [${fm.required_on_stage.join(', ')}]`,
    `additional_on_stage: [${fm.additional_on_stage.join(', ')}]`,
    `word_count_target: ${fm.word_count_target}`,
    `beats: [${fm.beats.join(', ')}]`,
    `beats_covered: [${fm.beats_covered.join(', ')}]`,
  ];
  const ageIds = Object.keys(fm.ages);
  if (ageIds.length > 0) {
    lines.push('ages:');
    for (const id of ageIds) lines.push(`  ${id}: ${fm.ages[id]}`);
  }
  lines.push('---', '');
  return lines.join('\n') + body;
}

/**
 * The reference bundle: a clean fluent chapter that scores 9/9 against the bible,
 * the planner-authored contract, and the keeper-maintained prior state.
 */
function referenceBundle(opts) {
  const nonce = opts && typeof opts.nonce === 'string' ? opts.nonce : mintNonce();
  const body = chapterBody(nonce);
  const target = wordCount(body);
  const contract = {
    pov: 'mara-vale',
    scene_date: '2131-04-19',
    location: 'veyra-bank',
    threads: { touch: ['crane-debt'], open: ['vault-echo'], close: [] },
    flashback: false,
    required_on_stage: ['mara-vale', 'dorian-ash'],
    word_count_target: target,
    beats: ['beat-vault-approach', 'beat-ledger-glimpse'],
  };
  const fm = {
    chapter_id: 'ch-vault-heist',
    pov: contract.pov,
    scene_date: contract.scene_date,
    location: contract.location,
    flashback: contract.flashback,
    threads: { touch: [...contract.threads.touch], open: [...contract.threads.open], close: [...contract.threads.close] },
    required_on_stage: [...contract.required_on_stage],
    additional_on_stage: ['night-ledger'],
    word_count_target: target,
    beats: [...contract.beats],
    beats_covered: [...contract.beats],
    ages: { 'mara-vale': 29 },
  };
  return {
    schema: 'ferrox.lore-consistency.bundle/1',
    chapter: { filename: 'ch-vault-heist.md', markdown: chapterMarkdown(fm, body) },
    lore: loreMarkdown(),
    trusted_contract: contract,
    prior_state: {
      previous_scene_date: '2131-04-02',
      chapters: [
        { chapter_id: 'ch-cold-open', scene_date: '2131-01-20' },
        { chapter_id: 'ch-flood-market', scene_date: '2131-04-02' },
      ],
      thread_events: [
        { thread: 'heist-plan', event: 'open', chapter_id: 'ch-cold-open' },
        { thread: 'cold-open-tail', event: 'open', chapter_id: 'ch-cold-open' },
        { thread: 'crane-debt', event: 'open', chapter_id: 'ch-flood-market' },
        { thread: 'heist-plan', event: 'touch', chapter_id: 'ch-flood-market' },
        { thread: 'cold-open-tail', event: 'close', chapter_id: 'ch-flood-market' },
      ],
    },
    thresholds: { word_tolerance_pct: 10, era_start: '2120-01-01', era_end: '2140-12-31' },
  };
}

function serializeBundle(bundle) {
  return JSON.stringify(bundle, null, 2) + '\n';
}

function referenceContent(opts) {
  return serializeBundle(referenceBundle(opts));
}

/** Rebuild a bundle's chapter markdown from an edited frontmatter object + body. */
function rebuildChapter(bundle, fmEdit, bodyEdit) {
  const base = referenceFm(bundle);
  const fm = { ...base, ...fmEdit };
  const body = bodyEdit ?? bundle.__body;
  bundle.chapter.markdown = chapterMarkdown(fm, body);
}

/** Internal: the reference frontmatter object for a bundle built by referenceBundle. */
function referenceFm(bundle) {
  const c = bundle.trusted_contract;
  return {
    chapter_id: 'ch-vault-heist',
    pov: c.pov,
    scene_date: c.scene_date,
    location: c.location,
    flashback: c.flashback,
    threads: { touch: [...c.threads.touch], open: [...c.threads.open], close: [...c.threads.close] },
    required_on_stage: [...c.required_on_stage],
    additional_on_stage: ['night-ledger'],
    word_count_target: c.word_count_target,
    beats: [...c.beats],
    beats_covered: [...c.beats],
    ages: { 'mara-vale': 29 },
  };
}

function mutants(opts) {
  const nonce = opts && typeof opts.nonce === 'string' ? opts.nonce : mintNonce();
  const body = chapterBody(nonce);
  const make = () => {
    const b = referenceBundle({ nonce });
    b.__body = body;
    return b;
  };

  // lc-m1: the ghost scene. The date is nudged to 2131-02-05, 4 days before the
  // broker's recorded death, so the lifecycle check passes and the corpse walks
  // legally. Only the monotone rule against the previous chapter (2131-04-02)
  // exposes the regression. Ages are dropped (self-declared, allowed to differ)
  // because the nudged date would shift the arithmetic.
  const m1 = make();
  m1.trusted_contract.scene_date = '2131-02-05';
  rebuildChapter(
    m1,
    {
      scene_date: '2131-02-05',
      additional_on_stage: ['night-ledger', 'silas-crane'],
      ages: {},
    },
    body + 'Silas Crane met them at the brass door himself, alive as rumor and twice as\ncareful.\n'
  );
  delete m1.__body;

  // lc-m2: the dead character on stage. Scene date untouched (2 months after the
  // death); the prose greets him warmly and reads like a planned reunion beat.
  const m2 = make();
  rebuildChapter(
    m2,
    { additional_on_stage: ['night-ledger', 'silas-crane'] },
    body + 'Silas Crane was there when they arrived, pouring a drink like the debt had\nnever changed hands.\n'
  );
  delete m2.__body;

  // lc-m3: the homoglyph. Every Dorian in the body gains a Cyrillic o; the reader
  // sees the name on every line, the word-boundary matcher cannot. Frontmatter
  // still declares him on stage.
  const m3 = make();
  rebuildChapter(m3, {}, body.split('Dorian').join(`D${HOMOGLYPH_O}rian`));
  delete m3.__body;

  // lc-m4: the lying flashback. The flag reads deliberate, the framing line sells
  // it as memory, and the date still lands AFTER the previous chapter.
  const m4 = make();
  m4.trusted_contract.flashback = true;
  rebuildChapter(
    m4,
    { flashback: true },
    'She would replay this night for years afterward; memory kept it in the\npresent tense.\n\n' + body
  );
  delete m4.__body;

  // lc-m5: the birthday boundary. 2131 minus 2099 reads as 32 on any skim; the
  // November birthday has not landed by the April scene, so the true age is 31.
  const m5 = make();
  rebuildChapter(m5, { ages: { 'mara-vale': 29, 'dorian-ash': 32 } }, body);
  delete m5.__body;

  // lc-m6: the resurrected thread. The callback line reads like craft; the ledger
  // says cold-open-tail was closed a chapter ago and never reopened.
  const m6 = make();
  m6.trusted_contract.threads.touch = ['crane-debt', 'cold-open-tail'];
  rebuildChapter(
    m6,
    { threads: { touch: ['crane-debt', 'cold-open-tail'], open: ['vault-echo'], close: [] } },
    body + 'The tail from the cold open brushed the plan once more, the way old jobs\nnever quite let go.\n'
  );
  delete m6.__body;

  return [
    {
      id: 'lc-m1',
      whyFluent:
        'ghost scene via a nudged date; the scene date sits days before the death so the lifecycle check passes and a skim sees a valid date; only the monotone rule exposes the regression',
      expectedDrop: 1,
      mustFail: ['LC-05'],
      content: serializeBundle(m1),
    },
    {
      id: 'lc-m2',
      whyFluent: 'a dead character walks on stage and the prose greets him warmly; nothing on the page says he died 2 months before the scene date',
      expectedDrop: 1,
      mustFail: ['LC-04'],
      content: serializeBundle(m2),
    },
    {
      id: 'lc-m3',
      whyFluent: 'a required-cast name rendered with a homoglyph character; the reader sees the name but the word-boundary match cannot',
      expectedDrop: 1,
      mustFail: ['LC-03'],
      content: serializeBundle(m3),
    },
    {
      id: 'lc-m4',
      whyFluent: 'the flashback flag reads deliberate and the framing sells memory; the date lands after the previous chapter, a regression wearing a costume',
      expectedDrop: 1,
      mustFail: ['LC-05'],
      content: serializeBundle(m4),
    },
    {
      id: 'lc-m5',
      whyFluent: 'off-by-one age at a birthday boundary; the year subtraction reads right on any skim and the birthday has not landed by the scene date',
      expectedDrop: 1,
      mustFail: ['LC-06'],
      content: serializeBundle(m5),
    },
    {
      id: 'lc-m6',
      whyFluent: 'a closed thread touched again; the callback line reads like craft and the prior-state ledger says the thread was wrapped 1 chapter ago',
      expectedDrop: 1,
      mustFail: ['LC-08'],
      content: serializeBundle(m6),
    },
  ];
}

function mutantYamlBlock(mutants_, indent) {
  return mutants_
    .map(
      (m) =>
        `${indent}- { id: ${m.id}, class: fluent-but-wrong, why_fluent: ${m.whyFluent.replace(/,/g, ';')}, ` +
        `expected_drop: ${m.expectedDrop}, must_fail: [${m.mustFail.join(', ')}], fixture: ${m.fixtureUri} }`
    )
    .join('\n');
}

/**
 * Assemble a concrete single-template card at seal time: real sealed URIs drop into
 * the committed shape. args: { referenceUri, mutants: [{ ...mutant, fixtureUri }],
 * rotationK?, lastValidated?, gateScriptHash? }
 */
function cardMarkdown(args) {
  const rotationK = args && Number.isFinite(args.rotationK) ? args.rotationK : 2;
  const lastValidated =
    args && typeof args.lastValidated === 'string' && args.lastValidated !== '' ? args.lastValidated : 'null';
  const head = ['---', 'card: 1', `gate_id: ${GATE_ID}`, 'domain: writing', 'tier: 2'];
  if (args && typeof args.gateScriptHash === 'string' && args.gateScriptHash !== '') {
    head.push(`gate_script_hash: ${args.gateScriptHash}`);
  }
  return [
    ...head,
    'relational_target:',
    '  artifact: the declared canon-facts block plus the planner-authored trusted chapter contract',
    '  relation: the chapter honors every declared fact and contract field it can be mechanically checked against',
    'disclosure_default: opaque',
    'checks:',
    '  - { id: LC-01, category: structure, desc: bible integrity holds, measures: parseCanonFacts over the lore member; store must be lore; every structured error fails }',
    '  - { id: LC-02, category: grounding, desc: contract referential integrity, measures: pov / location / required_on_stage / thread ids resolve against the declared canon }',
    '  - { id: LC-03, category: relation, desc: required cast present on the page, measures: word-boundary canonical-name or alias match for every on-stage id }',
    '  - { id: LC-04, category: relation, desc: status and lifecycle legal vs the scene date, measures: dead or departed entities off stage as of the effective scene date; no pre-introduction appearances }',
    '  - { id: LC-05, category: value, desc: timeline stamp legal, measures: date parses; era bounds; window membership; monotone vs previous chapter unless flashback; a forward flashback fails }',
    '  - { id: LC-06, category: value, desc: age arithmetic exact, measures: declared age equals birthdate vs scene date arithmetic; no birthdate means fail as unverifiable }',
    '  - { id: LC-07, category: structure, desc: POV contract echo exact, measures: frontmatter echoes the trusted contract; only additional_on_stage / ages / beats_covered self-declared; pov on stage and character-typed }',
    '  - { id: LC-08, category: relation, desc: thread ledger legality, measures: replay of prior_state thread events; touch or close of a non-open thread fails; double open fails }',
    '  - { id: LC-09, category: value, desc: the machine floor holds, measures: body word count within word_tolerance_pct of word_count_target; every contract beat in beats_covered }',
    'wrapped_tools:',
    '  - { name: node, version: 20.20.2, license: MIT, role: gate runtime }',
    '  - { name: canon-facts, version: 1.12.0, license: MIT, role: declared-facts parse via internal relative require }',
    '  - { name: js-yaml, version: 4.2.0, license: MIT, role: vendored YAML engine via internal relative require }',
    'validation:',
    `  reference: ${args.referenceUri}`,
    '  pool_min: 6',
    '  pool_status: full',
    '  mutants:',
    mutantYamlBlock(args.mutants, '    '),
    `  rotation_k: ${rotationK}`,
    `  last_validated: ${lastValidated}`,
    'gamed_modes:',
    '  - { mode: contract-satisfying wrongness; nudged dates; homoglyphs; lying flags; resurrected threads, status: sealed, note: opaque ids plus the rotating sealed fluent pool }',
    '  - { mode: prose violates canon outside the declared contract, status: crucible, note: judgment eyes plus the A4 receipt scope disclaimer on every run }',
    'escape_hatch_bans:',
    '  - { ban: dropping or rewriting trusted contract fields in the draft frontmatter, check: LC-07 }',
    '  - { ban: declaring an age for an entity with no declared birthdate, check: LC-06 }',
    '  - { ban: removing or renaming the canon-facts fence, check: LC-01 }',
    '---',
    '',
    '## Intent',
    'Tier 2 relational gate: the chapter vs the declared canon-facts block plus the',
    'planner-authored trusted contract. Prose judgment is never gated.',
    '',
    '## Gamed-mode rationale',
    'The pool encodes contract-satisfying wrongness; prose canon fidelity outside the',
    'declared contract routes to the judgment eyes with the scope disclaimer on every run.',
    '',
    '## Change log',
    '- 2026-07-23 authored in v1.13 Wave 3 with the sealed 6-mutant fluent pool.',
    '',
  ].join('\n');
}

module.exports = {
  GATE_ID,
  mintNonce,
  wordCount,
  loreMarkdown,
  chapterBody,
  referenceBundle,
  referenceContent,
  serializeBundle,
  mutants,
  cardMarkdown,
};
