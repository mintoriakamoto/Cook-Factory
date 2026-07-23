'use strict';
/**
 * Fluent fixture generators for the citation-sources gate (v1.13 Wave 3).
 *
 * ADR-SEALED-GATES: fixture CONTENT never enters the repo. Only these generators are
 * committed; the operator machine (and the test suite) calls them, seals the emitted
 * content into the sealed store, and fills the card's `sealed:sha256:` references at
 * seal time. Every emission carries a per-seal nonce (a codename token woven into the
 * text), so sealed instances differ per machine and can never hash-collide with a
 * repo blob.
 *
 * Fixtures are RESEARCH PACKETS (packet mode): the report embeds its own
 * `yaml canon-facts` sources block, so 1 sealed file carries both sides of the
 * relation and ledger-side mutants (drifted excerpt, retraction) stay expressible.
 * The 2-part invocation (`--ledger SOURCES.md report.md`) is covered by the exported
 * `reportContent` + `buildLedger` pair, which the test suite drives directly.
 *
 * Pool (5 mutants, all fluent-but-wrong, seeds from the v1.13 plan cross-audit
 * amendment A7):
 *   cs-m1  paraphrased quote, reads faithful, is not verbatim     must_fail CS-03
 *   cs-m2  transposed source ids, both resolve, quotes mismatch   must_fail CS-03
 *   cs-m3  retracted entry cited straight-faced as live support   must_fail CS-02
 *   cs-m4  ledger excerpt silently edited, content hash stale     must_fail CS-01
 *   cs-m5  legal ellipsis eliding a negation, claim flipped       must_fail CS-03
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GATE_ID = 'citation-sources';

/** Curly quotes, escape-spelled so intent is visible in committed source. */
const CQ_OPEN = '\u201C';
const CQ_CLOSE = '\u201D';

function mintNonce() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Tracked duplication of gate.cjs normalizeText (the gate executes main() on load,
 * so it cannot be required as a library). The suite proves the 2 copies agree: the
 * reference ledger hashes generated here must pass the gate's CS-01 recomputation.
 */
function normalizeText(s) {
  return s
    .normalize('NFC')
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2014\u2013\u2015]/g, '-') // em dash, en dash, horizontal bar
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The card-locked content anchor: sha256 of the normalized excerpt. */
function contentHash(excerpt) {
  return 'sha256:' + crypto.createHash('sha256').update(normalizeText(excerpt), 'utf8').digest('hex');
}

const MESH_EXCERPT =
  'The relay mesh retained 61 percent of its pre-flare throughput in urban enclaves, and the loss was concentrated in the final relay hop.';
const FLARE_EXCERPT =
  'The authorization order was signed 4 hours before the first uplink failure, and the review board found the signing chain complete.';
const FLARE_EXCERPT_NEGATED =
  'The authorization order was signed 4 hours before the first uplink failure, and the review board found the signing chain was not complete.';
const COURIER_EXCERPT =
  'Couriers reported that hand-carried transfers were slower but arrived intact far more often than relay bursts.';
const TARIFF_EXCERPT =
  'Enclave tariffs doubled within 2 quarters of the flare, while courier fees rose by less than a third.';

/**
 * The 4 ledger entries the reference cites. overrides:
 *   flareExcerpt   swap the flare-postmortem excerpt text
 *   flareHash      pin the flare-postmortem content_hash (stale-hash mutant)
 */
function ledgerEntries(overrides) {
  const o = overrides ?? {};
  const flareExcerpt = typeof o.flareExcerpt === 'string' ? o.flareExcerpt : FLARE_EXCERPT;
  return [
    {
      id: 'mesh-survey-2025',
      title: 'Post-flare mesh throughput survey',
      access: 'live',
      url: 'https://example.org/mesh-survey-2025',
      access_date: '2026-07-18',
      excerpt: MESH_EXCERPT,
      content_hash: contentHash(MESH_EXCERPT),
    },
    {
      id: 'flare-postmortem',
      title: 'Flare authorization postmortem',
      access: 'archived',
      url: 'https://archive.example.org/flare-postmortem',
      access_date: '2026-07-19',
      excerpt: flareExcerpt,
      content_hash: typeof o.flareHash === 'string' ? o.flareHash : contentHash(flareExcerpt),
    },
    {
      id: 'courier-interview',
      title: 'Courier field interviews, enclave circuit',
      access: 'offline',
      access_date: '2026-07-20',
      excerpt: COURIER_EXCERPT,
    },
    {
      id: 'tariff-ledger-study',
      title: 'Enclave tariff ledger study',
      access: 'paywalled',
      url: 'https://example.org/tariff-ledger-study',
      access_date: '2026-07-21',
      excerpt: TARIFF_EXCERPT,
      content_hash: contentHash(TARIFF_EXCERPT),
      retracted: true,
    },
  ];
}

/** Render the fenced canon-facts sources block for the given entries. */
function ledgerBlockLines(entries) {
  const lines = ['```yaml canon-facts', 'schema: canon-facts/v1', 'store: sources', 'sources:'];
  for (const e of entries) {
    lines.push(`  - id: ${e.id}`);
    lines.push(`    title: "${e.title}"`);
    lines.push(`    access: ${e.access}`);
    if (e.url !== undefined) lines.push(`    url: ${e.url}`);
    lines.push(`    access_date: ${e.access_date}`);
    lines.push(`    excerpt: "${e.excerpt}"`);
    if (e.content_hash !== undefined) lines.push(`    content_hash: ${e.content_hash}`);
    if (e.retracted === true) lines.push('    retracted: true');
  }
  lines.push('```');
  return lines;
}

/** Standalone SOURCES.md for the 2-part invocation: prose wrapped around the block. */
function ledgerContent(opts) {
  const o = opts ?? {};
  const nonce = typeof o.nonce === 'string' ? o.nonce : mintNonce();
  return [
    '# SOURCES: post-flare mesh resilience',
    '',
    `Capture codename: led-${nonce}. Every entry below was ingested with its excerpt`,
    'stored verbatim as the trusted quote anchor; archived and paywalled entries also',
    'carry the content hash of that excerpt.',
    '',
    ...ledgerBlockLines(ledgerEntries(o.entryOverrides)),
    '',
  ].join('\n');
}

/**
 * The report body. Every quote-and-marker construction the card contract defines is
 * exercised live: curly quotes across a line wrap (normalization), an internal
 * ellipsis over a benign span, a bracketed 1-word substitution, a properly
 * acknowledged retracted citation, a marker inside a code fence, and a marker inside
 * an HTML comment (the last 2 must NOT count; the reference passing proves it).
 */
function reportLines(nonce) {
  return [
    '---',
    'title: Post-flare mesh resilience, what the record supports',
    'claims: declared',
    `codename: cs-${nonce}`,
    'date: 2026-07-23',
    '---',
    '',
    '# Post-flare mesh resilience: what the record supports',
    '',
    '## Findings',
    '',
    `The survey is blunt about where the damage sits: ${CQ_OPEN}The relay mesh retained 61`,
    `percent of its pre-flare throughput in urban enclaves${CQ_CLOSE} [S:mesh-survey-2025], and`,
    'the remaining loss sat in the final relay hop, off the enclave floor.',
    '',
    'The postmortem stands on 2 findings: "The authorization order was signed ...',
    'the review board found the signing chain complete" [S:flare-postmortem], with',
    'the timing question settled by the archived copy.',
    '',
    'Field accounts agree on the tradeoff: "[Runners] reported that hand-carried',
    'transfers were slower but arrived intact far more often than relay bursts"',
    '[S:courier-interview]. The interviews were collected off the mesh.',
    '',
    'The tariff study has been withdrawn by its authors; its headline figure,',
    '"Enclave tariffs doubled within 2 quarters of the flare"',
    '[S:tariff-ledger-study retracted], stays in this report only as history.',
    '',
    '## Claims',
    '',
    '- The urban mesh kept most of its throughput after the flare. [S:mesh-survey-2025]',
    '- The signing chain on the authorization order was found complete.',
    '  [S:flare-postmortem]',
    '- Hand carriage traded speed for delivery reliability. [S:courier-interview]',
    '- Tariff growth outpaced courier fee growth, per a study since withdrawn.',
    '  [S:tariff-ledger-study retracted]',
    '',
    '## Method note',
    '',
    'Ledger ingest ran before drafting; the capture command is recorded verbatim:',
    '',
    '```',
    'ferrox canon ingest --source [S:never-a-source] --store SOURCES.md',
    '```',
    '',
    '<!-- reviewer scratch: [S:also-not-a-source] -->',
    'The stored excerpts are the only quote anchors this report uses.',
    '',
  ];
}

function joinLines(lines) {
  return lines.join('\n') + '\n';
}

/** Report only (no embedded ledger): the artifact for the 2-part invocation. */
function reportContent(opts) {
  const nonce = opts && typeof opts.nonce === 'string' ? opts.nonce : mintNonce();
  return joinLines(reportLines(nonce));
}

/** Assemble a packet: report + appendix carrying the embedded sources block. */
function packet(lines, entries) {
  return joinLines([...lines, '## Appendix: sources ledger', '', ...ledgerBlockLines(entries), '']);
}

/** The reference packet: report + matching embedded ledger. Scores 6/6, 0 WARNs. */
function referenceContent(opts) {
  const nonce = opts && typeof opts.nonce === 'string' ? opts.nonce : mintNonce();
  return packet(reportLines(nonce), ledgerEntries());
}

/** Write the standalone SOURCES.md under dir and return its path (2-part mode). */
function buildLedger(dir, opts) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SOURCES.md');
  fs.writeFileSync(file, ledgerContent(opts));
  return file;
}

function mutants(opts) {
  const nonce = opts && typeof opts.nonce === 'string' ? opts.nonce : mintNonce();
  const base = reportLines(nonce);

  // cs-m1: the survey quote becomes a faithful-reading paraphrase. Same number,
  // same shape, same citation; only character-level comparison notices.
  const m1 = base.map((l) =>
    l
      .replace(`${CQ_OPEN}The relay mesh retained 61`, `${CQ_OPEN}The relay mesh kept 61`)
      .replace(`percent of its pre-flare throughput in urban enclaves${CQ_CLOSE}`, `percent of its pre-flare throughput across urban enclaves${CQ_CLOSE}`)
  );

  // cs-m2: the survey and interview markers swap places on the quote paragraphs.
  // Both ids exist, so referential integrity passes; neither quote matches its
  // cited entry anymore. The Claims bullets keep their correct ids on purpose:
  // the transposition hides in the quoted prose, not on the claim surface.
  const m2 = base.map((l) =>
    l
      .replace(`enclaves${CQ_CLOSE} [S:mesh-survey-2025], and`, `enclaves${CQ_CLOSE} [S:courier-interview], and`)
      .replace('[S:courier-interview]. The interviews were collected off the mesh.', '[S:mesh-survey-2025]. The interviews were collected off the mesh.')
  );

  // cs-m3: the retracted tariff study is cited straight-faced as live support.
  // Quote verbatim, id resolving, prose confident: nothing on the surface says
  // the ledger flagged the entry retracted.
  const withdrawnAt = base.indexOf('The tariff study has been withdrawn by its authors; its headline figure,');
  const m3 = [
    ...base.slice(0, withdrawnAt),
    'The tariff record points the same direction: its headline figure,',
    '"Enclave tariffs doubled within 2 quarters of the flare"',
    '[S:tariff-ledger-study], anchors the cost side of the resilience story.',
    ...base.slice(withdrawnAt + 3),
  ].map((l) =>
    l.replace('- Tariff growth outpaced courier fee growth, per a study since withdrawn.', '- Tariff growth outpaced courier fee growth, per the tariff ledger study.').replace('  [S:tariff-ledger-study retracted]', '  [S:tariff-ledger-study]')
  );

  // cs-m4: the flare excerpt drifts after ingest (4 hours becomes 6) while the
  // content hash stays the one captured at ingest. The entry reads clean and
  // current; only the hash remembers. The report is byte-identical to the
  // reference: the rot is entirely ledger-side.
  const m4Entries = ledgerEntries({
    flareExcerpt: FLARE_EXCERPT.replace('signed 4 hours before', 'signed 6 hours before'),
    flareHash: contentHash(FLARE_EXCERPT),
  });

  // cs-m5: the ledger says the signing chain was NOT complete (hash recomputed,
  // ledger internally consistent); the report quote elides exactly those words
  // with a legally formatted internal ellipsis, flipping the finding.
  const m5Entries = ledgerEntries({ flareExcerpt: FLARE_EXCERPT_NEGATED });
  const m5 = base.map((l) =>
    l
      .replace('The postmortem stands on 2 findings: "The authorization order was signed ...', 'The postmortem stands on 2 findings: "The authorization order was signed 4')
      .replace('the review board found the signing chain complete" [S:flare-postmortem], with', 'hours before the first uplink failure, and the review board found the signing chain ... complete" [S:flare-postmortem], with')
  );

  return [
    {
      id: 'cs-m1',
      whyFluent: 'the quote reads faithful and keeps the source number and framing; it is a paraphrase, not the verbatim excerpt, and only character-level comparison notices',
      expectedDrop: 1,
      mustFail: ['CS-03'],
      content: packet(m1, ledgerEntries()),
    },
    {
      id: 'cs-m2',
      whyFluent: '2 markers are swapped between quotes; every id resolves so referential integrity passes, and each citation looks fully sourced while neither quote matches its cited entry',
      expectedDrop: 1,
      mustFail: ['CS-03'],
      content: packet(m2, ledgerEntries()),
    },
    {
      id: 'cs-m3',
      whyFluent: 'a retracted ledger entry is cited straight-faced as live support; the quote is verbatim and the id resolves, so the citation reads impeccable at a skim',
      expectedDrop: 1,
      mustFail: ['CS-02'],
      content: packet(m3, ledgerEntries()),
    },
    {
      id: 'cs-m4',
      whyFluent: 'the ledger excerpt was silently edited after ingest; the entry still reads clean and current, and only the content hash remembers what was actually captured',
      expectedDrop: 1,
      mustFail: ['CS-01'],
      content: packet(base, m4Entries),
    },
    {
      id: 'cs-m5',
      whyFluent: 'a legally formatted ellipsis elides the words that negate the finding; the trimmed quote reads like a faithful shortening while flipping the source claim',
      expectedDrop: 1,
      mustFail: ['CS-03'],
      content: packet(m5, m5Entries),
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
 * Assemble a concrete card at seal time: real sealed URIs drop into the committed
 * shape (single validation block, GATE-CARD-SPEC section 4).
 * args: { referenceUri, mutants: [{...m, fixtureUri}], rotationK?, lastValidated?,
 *         gateScriptHash? }
 */
function cardMarkdown(args) {
  const rotationK = args && Number.isFinite(args.rotationK) ? args.rotationK : 2;
  const lastValidated = args && typeof args.lastValidated === 'string' && args.lastValidated !== '' ? args.lastValidated : 'null';
  const head = ['---', 'card: 1', `gate_id: ${GATE_ID}`, 'domain: research', 'tier: 4'];
  if (args && typeof args.gateScriptHash === 'string' && args.gateScriptHash !== '') {
    head.push(`gate_script_hash: ${args.gateScriptHash}`);
  }
  return [
    ...head,
    'relational_target:',
    '  artifact: the SOURCES.md ledger',
    '  relation: every claim marker and quoted span in the report resolves against and matches the ledger',
    'disclosure_default: opaque',
    'checks:',
    '  - { id: CS-01, category: structure, desc: ledger parses with schema and internal integrity intact, measures: canon-facts sources validation plus content_hash equals the sha256 of the stored excerpt under the locked normalization }',
    '  - { id: CS-02, category: grounding, desc: every claim marker resolves honestly, measures: marker ids exist in the ledger; retraction annotations mirror the ledger exactly }',
    '  - { id: CS-03, category: grounding, desc: quoted spans are verbatim against their cited excerpts, measures: normalized match under the locked alteration grammar; beyond-grammar abstains as INDET; a negation-eliding internal ellipsis fails }',
    '  - { id: CS-04, category: value, desc: ledger url fields are syntactically valid, measures: WHATWG URL parse via node stdlib; syntax only, never fetched }',
    '  - { id: CS-05, category: grounding, desc: no unresolved declared claims, measures: with claims declared, every top-level list item carries at least 1 marker after comment and fence stripping }',
    '  - { id: CS-06, category: value, desc: dead ledger entries surface as advisories, measures: uncited entries emit WARN lines only; never fails by contract }',
    'wrapped_tools:',
    '  - { name: node, version: 20.20.2, license: MIT, role: gate runtime }',
    '  - { name: js-yaml, version: 4.2.0, license: MIT, role: ledger YAML parse, vendored }',
    'validation:',
    `  reference: ${args.referenceUri}`,
    '  pool_min: 5',
    '  pool_status: full',
    '  mutants:',
    mutantYamlBlock(args.mutants, '    '),
    `  rotation_k: ${rotationK}`,
    `  last_validated: ${lastValidated}`,
    'gamed_modes:',
    '  - { mode: fluent citation rot tuned to read faithful at a skim, status: sealed, note: exactly the pool; opaque ids plus the rotating fluent mutant set }',
    '  - { mode: prose asserts claims outside the declared markers with no marker at all, status: crucible, note: the research judgment eye plus the receipt scope disclaimer own it }',
    '  - { mode: resolving-but-unsupporting citation on a quoteless marker, status: crucible, note: relevance is judgment; the gate proves resolution and verbatim fidelity only }',
    'escape_hatch_bans:',
    '  - { ban: claim markers inside HTML comments or fenced code blocks do not count as markers, check: CS-05 }',
    '  - { ban: a retracted annotation on an entry the ledger does not declare retracted, check: CS-02 }',
    '---',
    '',
    '## Intent',
    'Grounding floor for research reports scored by relation to the SOURCES.md ledger:',
    'citations resolve, quotes are verbatim against ingest-time excerpts, the ledger has',
    'not drifted. No network anywhere; URL checks are syntax only.',
    '',
    '## Gamed-mode rationale',
    'Support strength and claim-surface honesty are judgment and route to the eyes; the',
    'pool encodes mechanical citation rot (paraphrase, transposed ids, silent retraction,',
    'drifted excerpt, negation-hiding trim). The 5 mutant seeds were enumerated in the',
    'v1.13 plan cross-audit (amendment A7), not in the original prior-art research.',
    '',
    '## Change log',
    '- 2026-07-23 authored in v1.13 Wave 3 with the sealed fluent pool.',
    '',
  ].join('\n');
}

module.exports = {
  GATE_ID,
  mintNonce,
  normalizeText,
  contentHash,
  ledgerEntries,
  ledgerContent,
  buildLedger,
  reportContent,
  referenceContent,
  mutants,
  cardMarkdown,
};
