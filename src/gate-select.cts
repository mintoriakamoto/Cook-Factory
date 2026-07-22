/**
 * UGE-01 — domain-keyed gate selection (the native universal gate-first registry).
 *
 * Port of the anvil DOMAIN-GATING catalog (ANVIL-PORT-SPEC.md §1), extended in MILESTONE v1.9 with
 * the 4 gate-pack domains (eval-harness, test-generation, agent-ops, business-docs — all executable
 * tier, cards at gates/<pack>/card.md). Pack-backed domains as of MILESTONE v1.11: those 4 plus
 * web-ui, whose pre-existing tier-1 registry row is now backed by the gates/web-ui pack (card at
 * gates/web-ui/card.md; aliases web/frontend/ui ride along). Rule: select the HIGHEST tier the domain admits. Ladder: 1 Executable · 2 Formal · 3 Reference · 4 Grounding · 5 Consistency (soft,
 * PRE-FILTER only — never the gate) · 6 Model-judge (subjective, route to Crucible).
 *
 *   selectGate(domain) -> { tier, archetype, route, preFilter, known }
 *     tiers 1-4 -> route 'gate-first' (a real gate exists; the climb loop applies).
 *     tier 6    -> route 'crucible' (judge-panel territory; gates are gameable here).
 *     unknown   -> route 'crucible', known:false (FAIL-SAFE: unknown domains are NOT gateable —
 *                  never pretend an objective gate exists where none was cataloged).
 *     preFilter is always true: the tier-5 consistency check is a cheap cross-cutting pre-filter
 *     hint that any route may run BEFORE its gate/judge; it is never selectable AS the gate.
 *
 *   listGateDomains() -> the 20 canonical registry keys (docs/UX).
 *
 * Normalization: lowercase, trim, spaces/underscores -> hyphens ('Tool Use' -> 'tool-use').
 * Anti-Goodhart (spec §1): the gate is the ceiling; judge != generator; low iteration count is a
 * feature. PURE: no fs/env/clock/network. Never throws.
 * ADR-457: compiles to ferrox-core/bin/lib/gate-select.cjs. `export =` shape.
 */

interface GateSelection {
  tier: number | null;
  archetype: string | null;
  route: 'gate-first' | 'crucible';
  preFilter: boolean;
  known: boolean;
}

/** Tier 5 (consistency) — cross-cutting cheap pre-filter, NEVER selectable as the gate. */
const PRE_FILTER_TIER = 5;

/** Alias -> canonical domain key (spec §1 aliases column, post-normalization form). */
const ALIASES: Record<string, string> = {
  data: 'data-sql',
  sql: 'data-sql',
  analytics: 'data-sql',
  web: 'web-ui',
  frontend: 'web-ui',
  ui: 'web-ui',
  'agentic-workflows': 'agentic',
  'tool-use': 'agentic',
  'autonomous-agents': 'agentic',
  config: 'infra',
  devops: 'infra',
  math: 'math-numeric',
  'structured-generation': 'structured-gen',
  json: 'structured-gen',
  constraints: 'logic',
  scheduling: 'logic',
  parsing: 'extraction',
  localization: 'translation',
  l10n: 'translation',
  triage: 'classification',
  labeling: 'classification',
  rag: 'research',
  'factual-synthesis': 'research',
  reports: 'long-form',
  content: 'writing',
  design: 'writing',
  conversation: 'writing',
  support: 'writing',
  evals: 'eval-harness',
  'eval-harness-integrity': 'eval-harness',
  'test-gen': 'test-generation',
  skills: 'agent-ops',
  'instruction-files': 'agent-ops',
  'skill-instruction-files': 'agent-ops',
  spreadsheets: 'business-docs',
  workbooks: 'business-docs',
};

/**
 * The 20-domain catalog: highest admissible tier + verification archetype. Rows 1-16 are the anvil
 * spec §1 table verbatim; the 4 v1.9 gate-pack domains follow, archetypes from their Gate Cards.
 * web-ui is pack-backed since v1.11 (gates/web-ui/card.md); its archetype row stays spec-verbatim.
 */
const REGISTRY: Record<string, { tier: number; archetype: string }> = {
  code: { tier: 1, archetype: 'test suite / compiler / type-checker / linter / SAST' },
  'data-sql': { tier: 1, archetype: 'query executes + row/value assertions, dbt tests, schema validation, golden-result diff' },
  'web-ui': { tier: 1, archetype: 'headless render w/o error, E2E assertions (Playwright), DOM/ARIA, visual diff, axe, Lighthouse' },
  agentic: { tier: 1, archetype: 'environment-state assertions: did the side effect happen (file/API/DB end-state matches spec)' },
  security: { tier: 1, archetype: 'exploit reproduces / regression test passes, fuzzing survives, SAST clean' },
  infra: { tier: 1, archetype: 'terraform plan dry-run, policy-as-code (OPA), does-it-boot/healthcheck, schema-valid manifests' },
  'math-numeric': { tier: 1, archetype: 'plug answer back in, symbolic equality (sympy), unit/dimensional analysis' },
  'eval-harness': { tier: 1, archetype: 'calibration stub triple (gold/random/planted-mutant) separates in order at declared deltas, leakage scan, scorer-bypass scan' },
  'test-generation': { tier: 1, archetype: 'mutation-kill rate vs the target module, coverage delta vs baseline, assert-quality AST scans (relational gate)' },
  'agent-ops': { tier: 1, archetype: 'dead-reference scan vs workspace + tool manifest, token budget, fenced-example execution, frontmatter schema' },
  'business-docs': { tier: 1, archetype: 'headless workbook recalc without error cells, formula-not-literal, perturbation probe, cross-sheet refs resolve' },
  'math-proof': { tier: 2, archetype: 'theorem prover (Lean/Coq)' },
  'structured-gen': { tier: 2, archetype: 'JSON-Schema / grammar / type validation (fails closed, near-free)' },
  logic: { tier: 2, archetype: 'SMT/constraint solver (Z3) checks output satisfies spec' },
  extraction: { tier: 3, archetype: 'field-level ground truth, round-trip reconstruction' },
  translation: { tier: 3, archetype: 'back-translation + semantic similarity (COMET), terminology-glossary compliance' },
  classification: { tier: 3, archetype: 'held-out labeled set, calibrated confidence, ensemble agreement' },
  research: { tier: 4, archetype: 'claim-decomposition -> per-claim NLI entailment vs cited passage -> support score' },
  'long-form': { tier: 4, archetype: 'claim-grounding gate + structural/constraint checks' },
  writing: { tier: 6, archetype: 'LLM-judge vs locked evidence-anchored rubric' },
};

/** Normalize a raw domain string: lowercase, trim, collapse spaces/underscores to hyphens. */
function normalizeDomain(domain: unknown): string {
  if (typeof domain !== 'string') return '';
  return domain.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * PURE. Resolve a domain to its gate tier, archetype, and route. Unknown/garbage -> crucible route
 * with known:false — the fail-safe: an uncataloged domain gets a judge panel, never a fake gate.
 */
function selectGate(domain?: unknown, opts?: unknown): GateSelection {
  void opts; // reserved (wiring waves may pass routing context); pure core ignores it
  const key = normalizeDomain(domain);
  const canonical = ALIASES[key] || key;
  const hit = REGISTRY[canonical];
  if (!hit) {
    return { tier: null, archetype: null, route: 'crucible', preFilter: true, known: false };
  }
  const route: GateSelection['route'] = hit.tier <= 4 ? 'gate-first' : 'crucible';
  return { tier: hit.tier, archetype: hit.archetype, route, preFilter: true, known: true };
}

/** PURE. The canonical registry keys (fresh array each call — no shared mutable state). */
function listGateDomains(): string[] {
  return Object.keys(REGISTRY);
}

export = { selectGate, listGateDomains, PRE_FILTER_TIER };
