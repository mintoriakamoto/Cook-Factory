/**
 * STRONG-01..05 + FF-B10/FF-B11 strength.* CLI router (Plan 07).
 *
 * Exposes the tested Phase-5 strength cores (Plans 02-06) as the eight locked-name
 * verbs `ferrox_run query strength.<verb>`:
 *   - strength.judge-check     (STRONG-01, strength-judge-check core)
 *   - strength.severity-route  (STRONG-04, strength-severity-route core)
 *   - strength.receipt         (STRONG-02, strength-receipt.recordReceipt — MUTATION)
 *   - strength.verify-receipt  (STRONG-02, strength-receipt.verifyReceipt)
 *   - strength.mutation-check  (STRONG-03, strength-mutation-check core)
 *   - strength.burndown-check  (STRONG-05, strength-burndown-check core)
 *   - strength.coverage-source (FF-B11,    strength-coverage-source core)
 *   - strength.merge-gate      (FF-B10,    strength-merge-gate aggregator)
 *
 * The router is the SOLE place operator-supplied CLI flags and config-resolved
 * store paths enter the pure cores. It resolves the operator's `strength.*` block
 * via loadConfig (Plan 01 propagation) and forwards EXPLICIT inputs; the cores
 * reach for no config, git, or clock. A missing required flag fails closed on the
 * error() InvalidArgs path (non-zero, no crash — threat T-05-18); alias drift is
 * guarded by the check-alias-drift STRENGTH family entry.
 *
 * The `merge-gate` handler is where evidence is GATHERED, then handed to the pure
 * evaluateMergeGate aggregator. Be precise about provenance (Fix 2 — no overclaim):
 *   STORE-GATHERED (the increment cannot forge these by omission):
 *     - receipts        ← the receipt store (strength.receipt_store)
 *     - coverage        ← REQUIREMENTS.md count vs the coverage baseline store
 *     - security open   ← the findings store (strength.findings_store) ∪ open SEC
 *                         rows in .planning/BACKLOG.md ∪ caller --findings
 *     - aged backlog    ← open security/correctness rows in .planning/BACKLOG.md
 *   CALLER-PROVIDED increment assertions (the orchestrator supplies these):
 *     - opened/resolved net counts, declared/actual ownership sets, the mutation
 *       observation, and the --hot-seam-serialized protocol assertion.
 * Every gather step is wrapped so a THROW is captured into the evidence `errors[]` —
 * an errored input verb is NEVER coerced to affirmative, so the aggregator blocks
 * (T-05-19). Fail-closed is preserved end-to-end: an absent coverage baseline and a
 * malformed store both block; only a genuinely clean, all-affirmative set passes.
 *
 * Determinism: no Date.now here. Every decision derives from EXPLICIT flags and
 * on-disk store state.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/strength-command-router.cjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { STRENGTH_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import strengthJudge = require('./strength-judge-check.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import strengthSeverity = require('./strength-severity-route.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import strengthReceipt = require('./strength-receipt.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import strengthMutation = require('./strength-mutation-check.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import disciplineDepth = require('./discipline-depth.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import disciplineDepthStore = require('./discipline-depth-store.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import crossAuditCadence = require('./cross-audit-cadence.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import integrationFailureClassify = require('./integration-failure-classify.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import integrationLanding = require('./integration-landing.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import blockerPolicy = require('./blocker-policy.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import authorityFence = require('./authority-fence.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import qualityPipeline = require('./quality-pipeline.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import gateSelect = require('./gate-select.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import strengthBurndown = require('./strength-burndown-check.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import strengthCoverage = require('./strength-coverage-source.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import strengthMergeGate = require('./strength-merge-gate.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coverageDelta = require('./coverage-delta.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coordOwnership = require('./coord-ownership-check.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coordHotSeam = require('./coord-hot-seam-check.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coordMigration = require('./coord-migration.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import atomicState = require('./atomic-state.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
const { loadConfig } = configLoader;

interface RouteStrengthCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
}

/** Manifest-default fallbacks (mirror config-defaults.manifest.json strength block). */
const DEFAULTS = {
  medium_cluster_threshold: 3,
  security_age_limit_days: 7,
  receipt_store: '.planning/strength/receipts.json',
  coverage_store: '.planning/strength/coverage-baseline.json',
  requirements_path: '.planning/REQUIREMENTS.md',
  findings_store: '.planning/strength/findings.json',
  backlog_path: '.planning/BACKLOG.md',
  security_categories: ['security', 'auth', 'crypto', 'injection', 'secrets', 'deserialization'],
  depth_store: '.planning/strength/depth-decisions.json',
  cross_audit_max_phases: 5,
};

/**
 * FAST-01: resolve model.risk_boundaries for the depth decider — config value
 * when present, else the manifest default (mirrors model-command-router's
 * resolveList; the depth decider and model.risk-grade MUST see the same
 * boundary list or the two grades could disagree).
 */
let manifestBoundariesCache: string[] | undefined;
function resolveRiskBoundaries(cwd: string): string[] {
  try {
    const cfg = loadConfig(cwd);
    const model = cfg && typeof cfg.model === 'object' && cfg.model !== null
      ? (cfg.model as Record<string, unknown>)
      : {};
    const fromCfg = model.risk_boundaries;
    if (Array.isArray(fromCfg) && fromCfg.length > 0) return fromCfg as string[];
  } catch {
    /* fall through to manifest */
  }
  if (manifestBoundariesCache !== undefined) return manifestBoundariesCache;
  try {
    const manifestPath = path.join(__dirname, '..', 'shared', 'config-defaults.manifest.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const model = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).model : undefined;
    const b = model && typeof model === 'object' ? (model as Record<string, unknown>).risk_boundaries : undefined;
    manifestBoundariesCache = Array.isArray(b) ? (b as string[]) : [];
  } catch {
    manifestBoundariesCache = [];
  }
  return manifestBoundariesCache;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Split a comma-separated list flag into trimmed, non-empty parts. */
function parseList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Resolve the operator's strength block from config (Plan 01 propagation). A load
 * failure collapses to an empty block; the per-key resolvers below then supply the
 * manifest defaults.
 */
function resolveStrength(cwd: string): Record<string, unknown> {
  try {
    const cfg = loadConfig(cwd);
    const s = cfg && typeof cfg.strength === 'object' && cfg.strength !== null ? cfg.strength : {};
    return s as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveNumberKey(s: Record<string, unknown>, key: keyof typeof DEFAULTS): number {
  const v = s[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : (DEFAULTS[key] as number);
}

function resolvePathKey(s: Record<string, unknown>, key: keyof typeof DEFAULTS, cwd: string): string {
  const v = s[key];
  const rel = typeof v === 'string' && v !== '' ? v : (DEFAULTS[key] as string);
  return path.join(cwd, rel);
}

function resolveSecurityCategories(s: Record<string, unknown>): string[] {
  const v = s.security_categories;
  return Array.isArray(v) && v.length > 0 ? (v as string[]) : DEFAULTS.security_categories;
}

function writeJson(result: unknown, raw: boolean): void {
  process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}

// ─── Individual verb handlers ──────────────────────────────────────────────────

function handleJudgeCheck(args: string[], raw: boolean, error: (m: string, r?: string) => void): void {
  const author = parseFlag(args, '--author');
  const judge = parseFlag(args, '--judge');
  if (author === undefined || judge === undefined) {
    error('Usage: ferrox-tools query strength.judge-check --author <id> --judge <id>');
    return;
  }
  const result = strengthJudge.evaluateJudgeCheck({ author_id: author, judge_id: judge });
  writeJson(result, raw);
}

function handleSeverityRoute(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const findingsRaw = parseFlag(args, '--findings');
  if (findingsRaw === undefined) {
    error('Usage: ferrox-tools query strength.severity-route --findings <json-array>');
    return;
  }
  let findings: unknown;
  try {
    findings = JSON.parse(findingsRaw);
  } catch {
    error('strength.severity-route: --findings must be a JSON array', 'InvalidArgs');
    return;
  }
  const s = resolveStrength(cwd);
  const result = strengthSeverity.evaluateSeverityRoute({
    findings: Array.isArray(findings) ? findings : [],
    securityCategories: resolveSecurityCategories(s),
    clusterThreshold: resolveNumberKey(s, 'medium_cluster_threshold'),
  });
  writeJson(result, raw);
}

function handleReceipt(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const requirement = parseFlag(args, '--requirement');
  const test = parseFlag(args, '--test');
  const exitRaw = parseFlag(args, '--exit-code');
  const logDigest = parseFlag(args, '--log-digest');
  const commit = parseFlag(args, '--commit');
  const exitCode = Number(exitRaw);
  if (
    !requirement || !test || exitRaw === undefined || !Number.isFinite(exitCode) ||
    logDigest === undefined || !commit
  ) {
    error('Usage: ferrox-tools query strength.receipt --requirement <id> --test <name> --exit-code <n> --log-digest <hash> --commit <sha>');
    return;
  }
  const s = resolveStrength(cwd);
  const statePath = resolvePathKey(s, 'receipt_store', cwd);
  const result = strengthReceipt.recordReceipt({
    statePath,
    requirement,
    test,
    failing_run: { exit_code: exitCode, log_digest: logDigest },
    commit,
  });
  writeJson(result, raw);
}

function handleVerifyReceipt(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const requirement = parseFlag(args, '--requirement');
  if (!requirement) {
    error('Usage: ferrox-tools query strength.verify-receipt --requirement <id>');
    return;
  }
  const s = resolveStrength(cwd);
  const statePath = resolvePathKey(s, 'receipt_store', cwd);
  const result = strengthReceipt.verifyReceipt({ statePath, requirement, repoDir: cwd });
  writeJson(result, raw);
}

function handleMutationCheck(args: string[], raw: boolean, error: (m: string, r?: string) => void): void {
  const requirement = parseFlag(args, '--requirement');
  const test = parseFlag(args, '--test');
  const flippedRaw = parseFlag(args, '--flipped');
  if (!test || flippedRaw === undefined) {
    error('Usage: ferrox-tools query strength.mutation-check --test <name> --flipped <true|false> [--requirement <id>]');
    return;
  }
  const result = strengthMutation.evaluateMutationCheck({
    requirement,
    test,
    mapped_test_flipped_to_red: flippedRaw === 'true',
  });
  writeJson(result, raw);
}

function handleBurndownCheck(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const openedRaw = parseFlag(args, '--opened');
  const resolvedRaw = parseFlag(args, '--resolved');
  const itemsRaw = parseFlag(args, '--items');
  const opened = Number(openedRaw);
  const resolved = Number(resolvedRaw);
  if (openedRaw === undefined || resolvedRaw === undefined || !Number.isFinite(opened) || !Number.isFinite(resolved)) {
    error('Usage: ferrox-tools query strength.burndown-check --opened <n> --resolved <n> [--items <json-array>]');
    return;
  }
  let items: unknown = [];
  if (itemsRaw !== undefined) {
    try {
      items = JSON.parse(itemsRaw);
    } catch {
      error('strength.burndown-check: --items must be a JSON array', 'InvalidArgs');
      return;
    }
  }
  const s = resolveStrength(cwd);
  const result = strengthBurndown.evaluateBurndown({
    opened,
    resolved,
    items: Array.isArray(items) ? items : [],
    age_limit_days: resolveNumberKey(s, 'security_age_limit_days'),
  });
  writeJson(result, raw);
}

function handleCoverageSource(args: string[], cwd: string, raw: boolean): void {
  const s = resolveStrength(cwd);
  const requirementsPath = resolvePathKey(s, 'requirements_path', cwd);
  const result = strengthCoverage.countCoverage({ requirementsPath });
  writeJson(result, raw);
}

/**
 * FF-B10 Fix 3: snapshot the coverage baseline at INCREMENT START. Writes the
 * current covered-requirement count (from strength.requirements_path) into
 * strength.coverage_store as `{ covered }`, atomically. The merge gate later reads
 * this as the `before` count, so `after > before` is a REAL advance — and because
 * the baseline now fails CLOSED (an absent store blocks), the increment MUST seed it
 * here rather than relying on a fail-safe-to-0 that let a no-op merge land.
 */
function handleCoverageBaseline(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  if (!args.includes('--snapshot')) {
    error('Usage: ferrox-tools query strength.coverage-baseline --snapshot');
    return;
  }
  const s = resolveStrength(cwd);
  const requirementsPath = resolvePathKey(s, 'requirements_path', cwd);
  const { covered } = strengthCoverage.countCoverage({ requirementsPath });
  const storePath = resolvePathKey(s, 'coverage_store', cwd);
  atomicState.updateJsonFileAtomic(storePath, () => ({ next: { covered }, changed: true, result: { covered } }));
  writeJson({ decision: 'snapshotted', covered }, raw);
}

// ─── merge-gate: EXPLICIT evidence gathering (fail-closed) ──────────────────────

/**
 * Read the covered-requirement baseline from the coverage store. Returns the numeric
 * `covered` field, or `null` when the baseline is ABSENT / blank / malformed / has a
 * non-numeric covered field.
 *
 * Fix 3 — fail CLOSED. The prior behavior returned 0 on ENOENT (fail-SAFE), which let
 * a no-op merge "land" whenever the baseline store was simply absent: before=0,
 * after=0 was a zero delta only if coverage was also 0, but any pre-existing coverage
 * made after>0 look like an advance against a phantom 0 baseline. A `null` here is
 * surfaced by the caller as `coverage-baseline-missing` → block, so the increment
 * MUST snapshot the baseline at start (strength.coverage-baseline --snapshot). A
 * non-ENOENT read error (EACCES/EISDIR) still THROWS → captured into errors[].
 */
function readCoverageBaseline(storePath: string): number | null {
  let text: string;
  try {
    text = fs.readFileSync(storePath, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; // absent → missing (block)
    throw err;
  }
  if (text === '') return null; // blank → missing (block)
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // corrupt baseline → missing (fail closed, block)
  }
  const covered = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).covered : undefined;
  return typeof covered === 'number' && Number.isFinite(covered) ? covered : null;
}

/** Lower-case a candidate token; a non-string collapses to ''. */
function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * Read the OPEN findings from the on-disk findings store (Fix 2). Shape:
 * `{ "open": [ { "category": "...", "severity": "..." }, ... ] }`. An ABSENT store
 * means "no open findings recorded" → [] (the safe, non-blocking default — a merge
 * is not blocked merely because no findings file exists). A PRESENT-but-malformed
 * store THROWS (JSON.parse) → the caller captures it into errors[] and the gate
 * blocks (fail closed on a corrupt security store). This is the un-forgeable half of
 * the security evidence: the increment cannot make a real open finding disappear by
 * omitting `--findings` from its manifest, because the store is read regardless.
 */
function readFindingsStore(storePath: string): unknown[] {
  let text: string;
  try {
    text = fs.readFileSync(storePath, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (text === '') return [];
  const parsed: unknown = JSON.parse(text);
  const open = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).open : undefined;
  return Array.isArray(open) ? open : [];
}

/** A backlog-derived burndown item: security/correctness category + optional age. */
interface BacklogDerived {
  findings: Record<string, unknown>[];
  items: { category: string; age_days?: number }[];
}

/**
 * Parse the OPEN security/correctness items from `.planning/BACKLOG.md` (Fix 2).
 * Scans only the `## Open` section's markdown table rows
 * (`| ID | Sev | From | Item | Blocks |`). A row is an open security/correctness
 * finding when its Sev cell is `SEC`/`SECURITY` (→ category security) or
 * `CORRECTNESS`/`CORR` (→ category correctness). An optional `age_days=<n>` /
 * `age: <n>d` token in the Item cell supplies the age fed to the burndown floor.
 *   - security rows → an open finding (raises open_security_count) the increment
 *     cannot silently omit from its manifest;
 *   - security + correctness rows (with a parsed age) → burndown items, so an aged
 *     security/correctness backlog item blocks even when the manifest omits it.
 * An ABSENT backlog → empty (test cwds / fresh repos). A present-but-unreadable file
 * THROWS → the caller captures it into errors[] (fail closed).
 */
function parseBacklogOpenItems(backlogPath: string): BacklogDerived {
  let text: string;
  try {
    text = fs.readFileSync(backlogPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { findings: [], items: [] };
    throw err;
  }
  const findings: Record<string, unknown>[] = [];
  const items: { category: string; age_days?: number }[] = [];
  let inOpen = false;
  for (const line of text.split('\n')) {
    if (/^##\s+/.test(line)) {
      inOpen = /^##\s+open\b/i.test(line);
      continue;
    }
    if (!inOpen || !line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // A well-formed row is | ID | Sev | From | Item | Blocks | → 7 split parts.
    if (cells.length < 6) continue;
    const sev = (cells[2] || '').toUpperCase();
    let category: string | undefined;
    if (sev === 'SEC' || sev === 'SECURITY') category = 'security';
    else if (sev === 'CORRECTNESS' || sev === 'CORR') category = 'correctness';
    if (!category) continue;
    const itemText = cells[4] || '';
    const ageMatch = /age(?:_days)?\s*[=:]\s*(\d+)|age:\s*(\d+)\s*d/i.exec(itemText);
    const age_days = ageMatch ? Number(ageMatch[1] ?? ageMatch[2]) : undefined;
    if (category === 'security') findings.push({ category: 'security' });
    items.push(age_days === undefined ? { category } : { category, age_days });
  }
  return { findings, items };
}

/**
 * FAST-01 strength.depth-decide — compute AND persist the process-depth decision
 * for a requirement. The persisted record is what the merge-gate later audits
 * (a fast claim without a matching record is depth-decision-not-valid). An
 * existing escalated flag (FAST-02 ratchet) is forwarded as priorGateFailure so
 * a ratcheted requirement can never re-decide its way back to fast.
 */
function handleDepthDecide(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const requirement = parseFlag(args, '--requirement');
  const selfGrade = parseFlag(args, '--self-grade');
  if (!requirement || selfGrade === undefined) {
    error('Usage: ferrox-tools query strength.depth-decide --requirement <id> --self-grade <grade> [--paths <a,b>] [--categories <a,b>] [--declared-depth <fast|full>]');
    return;
  }
  const s = resolveStrength(cwd);
  const statePath = resolvePathKey(s, 'depth_store', cwd);
  const paths = parseList(parseFlag(args, '--paths'));
  const categories = parseList(parseFlag(args, '--categories'));
  const prior = disciplineDepthStore.readDepthDecision({ statePath, requirement });
  const decision = disciplineDepth.evaluateDisciplineDepth({
    paths,
    categories,
    riskBoundaries: resolveRiskBoundaries(cwd),
    selfGrade,
    declaredDepth: parseFlag(args, '--declared-depth'),
    priorGateFailure: prior !== null && prior.escalated === true,
  });
  const record = disciplineDepthStore.recordDepthDecision({
    statePath,
    requirement,
    record: {
      depth: decision.depth,
      reasons: decision.reasons,
      matched: decision.matched,
      riskGrade: decision.riskGrade,
      auditTier: decision.auditTier,
      paths,
      categories,
    },
  });
  writeJson({ ...decision, escalated: record.escalated }, raw);
}

function handleMergeGate(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const increment = parseFlag(args, '--increment');
  const requirements = parseList(parseFlag(args, '--requirements'));
  const declaredRaw = parseFlag(args, '--declared');
  const actualRaw = parseFlag(args, '--actual');
  const filesRaw = parseFlag(args, '--files');
  const openedRaw = parseFlag(args, '--opened');
  const resolvedRaw = parseFlag(args, '--resolved');
  const mutationTest = parseFlag(args, '--mutation-test');
  const mutationFlippedRaw = parseFlag(args, '--mutation-flipped');

  // FAST-02: only the EXACT literal 'fast' activates the fast path; absent,
  // 'full', and every garbage enum keep today's full semantics (fail closed).
  const fastClaim = parseFlag(args, '--depth') === 'fast';
  // FAST-03b: the EXACT literal 'cross' activates the 3-eye cross-audit path.
  const crossClaim = parseFlag(args, '--audit-tier') === 'cross';

  // Required increment-context flags. A missing one fails closed on InvalidArgs.
  // On the fast OR cross path the mutation flags are NOT required — receipts+mutation
  // are replaced by the depth decision / cross-audit; every other flag stays mandatory.
  if (
    !increment || requirements.length === 0 ||
    declaredRaw === undefined || actualRaw === undefined || filesRaw === undefined ||
    openedRaw === undefined || resolvedRaw === undefined ||
    (!fastClaim && !crossClaim && (mutationTest === undefined || mutationFlippedRaw === undefined))
  ) {
    error(
      'Usage: ferrox-tools query strength.merge-gate --increment <id> --requirements <a,b> ' +
      '--declared <files> --actual <files> --files <files> --opened <n> --resolved <n> ' +
      '--mutation-test <name> --mutation-flipped <true|false> [--depth <fast|full>] ' +
      '[--diff-base <ref>] [--hot-seam-serialized <true|false>] ' +
      '[--findings <json>] [--items <json>] [--migration-number <n>]',
    );
    return;
  }

  const s = resolveStrength(cwd);
  const errors: string[] = [];

  // 1. receipts — verify-receipt across the increment's requirements; 'valid'
  //    only when EVERY requirement has a valid red-green receipt.
  let receipts: string | undefined;
  try {
    const receiptStore = resolvePathKey(s, 'receipt_store', cwd);
    const allValid = requirements.every(
      (r) => strengthReceipt.verifyReceipt({ statePath: receiptStore, requirement: r, repoDir: cwd }).decision === 'valid',
    );
    receipts = allValid ? 'valid' : 'incomplete';
  } catch (e) {
    errors.push(`verify-receipt:${(e as Error).message}`);
  }

  // 2. coverage — coverage-source (after) vs the coverage-store baseline (before)
  //    fed to coverage-delta; a no-op merge cannot fake a land (delta must be > 0).
  let coverage: string | undefined;
  try {
    const requirementsPath = resolvePathKey(s, 'requirements_path', cwd);
    const before = readCoverageBaseline(resolvePathKey(s, 'coverage_store', cwd));
    if (before === null) {
      // Fix 3: fail CLOSED — an absent/unreadable baseline cannot prove an advance.
      errors.push('coverage-baseline-missing');
    } else {
      const after = strengthCoverage.countCoverage({ requirementsPath }).covered;
      coverage = coverageDelta.evaluateCoverageDelta(before, after).decision;
    }
  } catch (e) {
    errors.push(`coverage-source:${(e as Error).message}`);
  }

  // 3. mutation — explicit observed flip forwarded to the mutation-check core.
  let mutation: string | undefined;
  try {
    mutation = strengthMutation.evaluateMutationCheck({
      requirement: increment,
      test: mutationTest,
      mapped_test_flipped_to_red: mutationFlippedRaw === 'true',
    }).decision;
  } catch (e) {
    errors.push(`mutation-check:${(e as Error).message}`);
  }

  // 4. ownership — coord ownership-check(declared, actual). 'ok' iff actual ⊆ declared.
  let ownership: string | undefined;
  try {
    ownership = coordOwnership.evaluateOwnership({
      declared: parseList(declaredRaw),
      actual: parseList(actualRaw),
    }).decision;
  } catch (e) {
    errors.push(`ownership-check:${(e as Error).message}`);
  }

  // 5. hot_seam — the seam-serialization PROTOCOL honored for THIS increment.
  //    Phase-5 cross-audit Fix 1 redefinition. The evidence is NOT "the increment
  //    touches no seam" — that inverted meaning deadlocked the gate: an HONEST
  //    migration/lockfile increment (which DOES touch a seam) could never reach
  //    'serialized', so the only way to pass was to LIE by omitting the seam files
  //    from --files. The evidence now means the orchestrator ASSERTS the global
  //    serial lock was held for this increment (`--hot-seam-serialized true`):
  //      - files touch NO seam ('parallel-ok') → nothing to serialize → 'serialized'.
  //      - files touch a seam ('serialize-global') AND the serialized assertion is
  //        present → 'serialized' (an honest, serialized migration increment passes).
  //      - files touch a seam WITHOUT the assertion → 'not-serialized' → the
  //        aggregator blocks (hot-seam-not-serialized). Omitting the flag can only
  //        make the gate STRICTER, never laxer, so this is not a new bypass.
  const hotSeamSerialized = parseFlag(args, '--hot-seam-serialized') === 'true';
  let hot_seam: string | undefined;
  try {
    const coordBlock = (loadConfig(cwd).coordination ?? {}) as Record<string, unknown>;
    const seams = Array.isArray(coordBlock.hot_seams) ? (coordBlock.hot_seams as string[]) : [];
    const seamDecision = coordHotSeam.evaluateHotSeam({ filesModified: parseList(filesRaw), seams }).decision;
    hot_seam = seamDecision === 'parallel-ok'
      ? 'serialized'
      : (hotSeamSerialized ? 'serialized' : 'not-serialized');
  } catch (e) {
    errors.push(`hot-seam-check:${(e as Error).message}`);
  }

  // 6. burndown — CALLER-PROVIDED net counts (opened/resolved are per-increment
  //    deltas that no static store can supply) PLUS the STORE-GATHERED aged items:
  //    open security/correctness rows parsed from the REAL .planning/BACKLOG.md
  //    (Fix 2). An aged security/correctness backlog item now blocks the burndown
  //    floor even if the increment omits it from --items.
  let burndown: string | undefined;
  try {
    const itemsRaw = parseFlag(args, '--items');
    let callerItems: unknown = [];
    if (itemsRaw !== undefined) callerItems = JSON.parse(itemsRaw);
    const callerItemsArr: unknown[] = Array.isArray(callerItems) ? (callerItems as unknown[]) : [];
    const backlogItems = parseBacklogOpenItems(resolvePathKey(s, 'backlog_path', cwd)).items;
    // evaluateBurndown reads each item's category/age_days defensively, so the merged
    // list (caller items ∪ backlog-derived items) is cast to the loose item shape.
    const mergedItems = [...callerItemsArr, ...backlogItems] as { category: unknown; age_days: unknown }[];
    burndown = strengthBurndown.evaluateBurndown({
      opened: Number(openedRaw),
      resolved: Number(resolvedRaw),
      items: mergedItems,
      age_limit_days: resolveNumberKey(s, 'security_age_limit_days'),
    }).decision;
  } catch (e) {
    errors.push(`burndown-check:${(e as Error).message}`);
  }

  // 7. severity findings — open security + open critical/high counts over the UNION
  //    of THREE sources (Fix 2): caller-supplied --findings, the on-disk findings
  //    store (strength.findings_store), and open SEC rows in .planning/BACKLOG.md.
  //    Two of the three are on-disk stores the increment cannot silently omit, so a
  //    real open security finding CANNOT ship by leaving --findings out of the
  //    manifest. A malformed store/backlog THROWS → captured → block (fail closed).
  let open_security_count: number | undefined;
  let open_critical_high_count: number | undefined;
  try {
    const findingsRaw = parseFlag(args, '--findings');
    const callerFindings: unknown = findingsRaw === undefined ? [] : JSON.parse(findingsRaw);
    const callerFindingsArr: unknown[] = Array.isArray(callerFindings) ? (callerFindings as unknown[]) : [];
    const storeFindings = readFindingsStore(resolvePathKey(s, 'findings_store', cwd));
    const backlogFindings = parseBacklogOpenItems(resolvePathKey(s, 'backlog_path', cwd)).findings;
    const list: unknown[] = [
      ...callerFindingsArr,
      ...storeFindings,
      ...backlogFindings,
    ];
    const securitySet = new Set(resolveSecurityCategories(s).map(norm));
    securitySet.delete('');
    open_security_count = list.filter((f) => securitySet.has(norm((f as Record<string, unknown>)?.category))).length;
    open_critical_high_count = list.filter((f) => {
      const sev = norm((f as Record<string, unknown>)?.severity);
      return sev === 'critical' || sev === 'high';
    }).length;
  } catch (e) {
    errors.push(`severity-route:${(e as Error).message}`);
  }

  // 8. consume-migration (FF-B15, optional) — when an allocated number is given,
  //    consume it once; a replay / uncentral verdict is a hard block captured as
  //    an error (a merge whose migration number does not validate must not land).
  const migrationRaw = parseFlag(args, '--migration-number');
  if (migrationRaw !== undefined) {
    const migrationNumber = Number(migrationRaw);
    if (!Number.isFinite(migrationNumber)) {
      errors.push('consume-migration:non-finite-number');
    } else {
      try {
        const coord = (loadConfig(cwd).coordination ?? {}) as Record<string, unknown>;
        const migStore = typeof coord.migration_store === 'string' && coord.migration_store !== ''
          ? path.join(cwd, coord.migration_store)
          : path.join(cwd, '.planning/coord/migration-seq.json');
        const decision = coordMigration.consumeMigration({ statePath: migStore, number: migrationNumber }).decision;
        if (decision !== 'consumed') errors.push(`consume-migration:${decision}`);
      } catch (e) {
        errors.push(`consume-migration:${(e as Error).message}`);
      }
    }
  }

  // FAST-02 depth audit. On a fast claim the gate does NOT trust the flag — it
  //  (a) reads the PERSISTED depth decision for EVERY requirement and requires
  //      each to be a recorded 'fast', and
  //  (b) RE-GRADES the ACTUAL merged files (--files, and any --diff-base git
  //      diff) against the SAME risk boundaries the decider used.
  // depth_decision is 'valid' only when both hold. A boundary that appears in
  // the real diff but not in the decider's inputs (the anti-gaming case) makes
  // the re-grade 'full', so 'valid' is withheld and the gate blocks. Withholding
  // can only make the gate STRICTER, never laxer, so this is not a new bypass.
  let depth: string | undefined;
  let depth_decision: string | undefined;
  const depthStorePath = resolvePathKey(s, 'depth_store', cwd);
  if (fastClaim) {
    depth = 'fast';
    try {
      const boundaries = resolveRiskBoundaries(cwd);
      const actualFiles = collectActualFiles(cwd, parseList(filesRaw), parseFlag(args, '--diff-base'));
      const reGrade = disciplineDepth.evaluateDisciplineDepth({
        paths: actualFiles,
        categories: [],
        riskBoundaries: boundaries,
        selfGrade: 'standard',
      });
      const everyReqFast = requirements.every((r) => {
        const rec = disciplineDepthStore.readDepthDecision({ statePath: depthStorePath, requirement: r });
        return rec !== null && rec.depth === 'fast' && rec.escalated !== true;
      });
      depth_decision = everyReqFast && reGrade.depth === 'fast' ? 'valid' : 'invalid';
    } catch (e) {
      errors.push(`depth-audit:${(e as Error).message}`);
    }
  }

  // FAST-03b: the cross-audit path forwards the 3-eye panel verdict. The workflow
  // runs codex ∥ gemini ∥ an internal adversarial subagent and passes the aggregate
  // as --cross-audit <passed|...>; anything but 'passed' blocks (cross-audit-not-passed).
  const audit_tier = crossClaim ? 'cross' : parseFlag(args, '--audit-tier');
  const cross_audit = crossClaim ? (parseFlag(args, '--cross-audit') ?? 'missing') : undefined;

  const result = strengthMergeGate.evaluateMergeGate({
    depth,
    depth_decision,
    audit_tier,
    cross_audit,
    receipts,
    coverage,
    mutation,
    ownership,
    hot_seam,
    burndown,
    open_security_count,
    open_critical_high_count,
    errors,
  });

  // FAST-02 ratchet: a BLOCK on the fast path escalates EVERY named requirement
  // one-way — the next depth-decide for it returns full (priorGateFailure). A
  // full-path block does not ratchet (it was already full).
  if (fastClaim && result.decision === 'block') {
    for (const r of requirements) {
      try {
        disciplineDepthStore.markEscalated({ statePath: depthStorePath, requirement: r });
      } catch {
        /* best-effort ratchet; the block already stands */
      }
    }
  }

  // Surface the gathered errors[] for observability (e.g. coverage-baseline-missing)
  // WITHOUT changing the pass shape the hook parses ({decision, reasons}).
  writeJson(errors.length > 0 ? { ...result, errors } : result, raw);
}

/**
 * FAST-02 anti-gaming helper — the set of files the merge ACTUALLY touches. The
 * caller's --files list UNION the git diff against --diff-base (when given and
 * the cwd is a real repo). A boundary file the caller omits from --files still
 * appears via the diff, so it cannot be hidden from the re-grade.
 */
function collectActualFiles(cwd: string, declaredFiles: string[], diffBase: string | undefined): string[] {
  const set = new Set<string>(declaredFiles);
  if (diffBase !== undefined && diffBase !== '') {
    try {
      const out = execFileSync('git', ['diff', '--name-only', diffBase], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split('\n')) {
        const f = line.trim();
        if (f !== '') set.add(f);
      }
    } catch {
      /* no diff available (not a repo / bad ref) — fall back to declared files */
    }
  }
  return [...set];
}

/**
 * XAUD-01 strength.cross-audit-cadence — decide whether the EXPENSIVE 3-eye cross-audit fires now.
 * Never-trust-one-AI is preserved (audit is non-negotiable); this only batches it to milestone cadence
 * so the cheap gate carries per-phase and the expensive audit is paid once per body-of-work.
 * Read-only decision; `maxPhasesWithoutAudit` comes from config strength.cross_audit_max_phases (dflt 5).
 */
function handleCrossAuditCadence(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const event = parseFlag(args, '--event');
  if (event === undefined) {
    error('Usage: ferrox-tools query strength.cross-audit-cadence --event <phase-complete|milestone-complete|standalone-complete> [--crosses-risk-boundary] [--at-integration-boundary] [--phases-since-audit <n>]', 'InvalidArgs');
    return;
  }
  const s = resolveStrength(cwd);
  const sinceRaw = parseFlag(args, '--phases-since-audit');
  const since = Number(sinceRaw);
  const result = crossAuditCadence.evaluateCrossAuditCadence({
    event,
    crossesRiskBoundary: args.includes('--crosses-risk-boundary'),
    atIntegrationBoundary: args.includes('--at-integration-boundary'),
    phasesSinceLastAudit: Number.isFinite(since) ? since : 0,
    maxPhasesWithoutAudit: resolveNumberKey(s, 'cross_audit_max_phases'),
  });
  writeJson(result, raw);
}

/** INTG-03 strength.classify-failures — aggregate-head regression-vs-env-vs-flake triage. */
function handleClassifyFailures(args: string[], raw: boolean, error: (m: string, r?: string) => void): void {
  const failuresRaw = parseFlag(args, '--failures');
  if (failuresRaw === undefined) {
    error('Usage: ferrox-tools query strength.classify-failures --failures <a|b|c> [--baseline <..>] [--env-patterns <..>] [--flake-patterns <..>]', 'InvalidArgs');
    return;
  }
  // '|' separated so failure names may contain commas/colons
  const split = (v: string | undefined) => (v === undefined ? [] : v.split('|').map((s) => s.trim()).filter((s) => s !== ''));
  writeJson(integrationFailureClassify.classifyFailures({
    failures: split(failuresRaw),
    baseline: split(parseFlag(args, '--baseline')),
    envPatterns: split(parseFlag(args, '--env-patterns')),
    flakePatterns: split(parseFlag(args, '--flake-patterns')),
  }), raw);
}

/** INTG-01 strength.integration-landing — ff-only land gate. */
function handleIntegrationLanding(args: string[], raw: boolean): void {
  writeJson(integrationLanding.decideIntegrationLanding({
    mergedHeadProven: args.includes('--merged-head-proven'),
    ffOnlyPossible: args.includes('--ff-only'),
    protectedPathsClean: args.includes('--protected-clean'),
  }), raw);
}

/** INTG-04 strength.blocker-policy — park-and-continue vs halt. */
function handleBlockerPolicy(args: string[], raw: boolean): void {
  writeJson(blockerPolicy.decideBlockerAction({
    independentWorkRemaining: args.includes('--independent-work-remaining'),
    requiresHumanAuthority: args.includes('--requires-human'),
  }), raw);
}

/**
 * QUAL-01 strength.quality-pipeline — the free deterministic hygiene toolchain for a language
 * (format -> lint -> security). `--language <lang>` resolves the per-ecosystem tools; unknown -> run nothing.
 */
function handleQualityPipeline(args: string[], raw: boolean): void {
  const i = args.indexOf('--language');
  const language = i >= 0 && i + 1 < args.length ? args[i + 1] : '';
  writeJson(qualityPipeline.selectToolchain(language), raw);
}

/**
 * UGE-08 strength.gate-select — the UGE-01 domain-keyed gate registry over the CLI.
 * `--domain <d>` -> selectGate: { tier, archetype, route, preFilter, known } (output is
 * always JSON; a `--json` flag is tolerated as a no-op). `--list` -> the 20 canonical
 * registry keys. Unknown domains route 'crucible' with known:false — the fail-safe.
 */
function handleGateSelect(args: string[], raw: boolean, error: (m: string, r?: string) => void): void {
  if (args.includes('--list')) {
    writeJson({ domains: gateSelect.listGateDomains() }, raw);
    return;
  }
  const domain = parseFlag(args, '--domain');
  if (domain === undefined) {
    error('Usage: ferrox-tools query strength.gate-select --domain <domain> | --list', 'InvalidArgs');
    return;
  }
  writeJson(gateSelect.selectGate(domain), raw);
}

/** INTG-05 strength.authority-check — deny-set fence. */
function handleAuthorityCheck(args: string[], raw: boolean, error: (m: string, r?: string) => void): void {
  const op = parseFlag(args, '--op');
  if (op === undefined) {
    error('Usage: ferrox-tools query strength.authority-check --op <op> [--denied <a,b>]', 'InvalidArgs');
    return;
  }
  const denied = parseList(parseFlag(args, '--denied'));
  writeJson(authorityFence.checkAuthority({ op, denied: denied.length > 0 ? denied : undefined }), raw);
}

function routeStrengthCommand({ args, cwd, raw, error }: RouteStrengthCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: STRENGTH_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_s: string, available: string[]) => `Unknown strength subcommand. Available: ${available.join(', ')}`,
    handlers: {
      'judge-check': () => handleJudgeCheck(args, raw, error),
      'severity-route': () => handleSeverityRoute(args, cwd, raw, error),
      'receipt': () => handleReceipt(args, cwd, raw, error),
      'depth-decide': () => handleDepthDecide(args, cwd, raw, error),
      'verify-receipt': () => handleVerifyReceipt(args, cwd, raw, error),
      'mutation-check': () => handleMutationCheck(args, raw, error),
      'burndown-check': () => handleBurndownCheck(args, cwd, raw, error),
      'coverage-source': () => handleCoverageSource(args, cwd, raw),
      'coverage-baseline': () => handleCoverageBaseline(args, cwd, raw, error),
      'merge-gate': () => handleMergeGate(args, cwd, raw, error),
      'cross-audit-cadence': () => handleCrossAuditCadence(args, cwd, raw, error),
      'classify-failures': () => handleClassifyFailures(args, raw, error),
      'integration-landing': () => handleIntegrationLanding(args, raw),
      'blocker-policy': () => handleBlockerPolicy(args, raw),
      'authority-check': () => handleAuthorityCheck(args, raw, error),
      'quality-pipeline': () => handleQualityPipeline(args, raw),
      'gate-select': () => handleGateSelect(args, raw, error),
    },
  });
}

export = { routeStrengthCommand };
