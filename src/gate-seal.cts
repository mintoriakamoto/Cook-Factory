/**
 * SEAL-01: the sealed gate asset framework (ADR-SEALED-GATES decisions 1, 3, 4).
 *
 * Content-addressed store for gate assets that must stay outside the builder's reach:
 * gate scripts, reference fixtures, mutant fixtures, hidden rubrics. Object path:
 * `<store>/sha256/<hh>/<full-64-hex>` (first 2 hex chars shard the directory); store root
 * defaults to `~/.cache/ferrox/gates/sealed` and is overridable with env FERROX_SEALED_STORE
 * or the explicit `storeRoot` option. The object name IS the content hash: sealGet re-hashes
 * on read and fails closed on mismatch. Nothing here ever enters git.
 *
 * Repo-visibility check (decision 4): a sealed fixture whose sha256 equals the sha256 of ANY
 * blob in the card repo's HEAD tree, tracked working tree, or the untracked scan directories
 * is REJECTED with E_FIXTURE_REPO_VISIBLE. Sealing a repo-visible file must not launder it:
 * committed fixtures are burned (published repos and git history are retrieval surfaces).
 *
 * validateGateCard(card, opts) is the enforcement point (GATE-CARD-SPEC section 6):
 *   static:  every fixture is a `sealed:sha256:` URI (else E_UNSEALED_FIXTURE), present and
 *            intact in the store (else E_SEALED_OBJECT_MISSING / E_SEALED_OBJECT_CORRUPT),
 *            not repo-visible (else E_FIXTURE_REPO_VISIBLE); the fluent mutant pool has >= 2
 *            members during migration (else E_POOL_TOO_SMALL) and warns W_POOL_BELOW_MIN
 *            under pool_min.
 *   sampled: rotation_k mutants drawn per run via mutant-rotation (seed sha256(runId:gateId));
 *            the run record carries runId + gateId + sampled id/hash pairs for replay.
 *   dynamic: when opts.gateCmd is provided the sealed gate runs against the fixtures:
 *            reference must score M/M with zero FAIL lines (else E_REFERENCE_NOT_GREEN);
 *            every sampled mutant must drop >= expected_drop and emit every must_fail id
 *            (else E_MUTANT_NOT_CAUGHT - a surviving pool member is burned and fails the
 *            GATE's validation, not just that mutant); every emitted FAIL token must be a
 *            v2 `<ID> <category>` from the card inventory unless the check is disclosure
 *            `named` (else E_BAD_FAIL_SURFACE / E_UNKNOWN_CHECK_ID).
 *
 * Trust boundary unchanged: cards and sealed paths are ORCHESTRATOR artifacts; builders see
 * only the task spec and the opaque FAIL surface. ADR-457: compiles to
 * ferrox-core/bin/lib/gate-seal.cjs. `export =` shape. Never throws.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import yaml = require('js-yaml');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import gateRunner = require('./gate-runner.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import mutantRotation = require('./mutant-rotation.cjs');

const SEALED_URI_RE = /^sealed:sha256:([0-9a-f]{64})$/;
const FLUENT_CLASS = 'fluent-but-wrong';
/** Migration floor (ADR decision 5 step 4): a pool below 2 fluent mutants cannot validate. */
const POOL_MIGRATION_FLOOR = 2;
const DEFAULT_POOL_MIN = 5;

const CODES = {
  E_UNSEALED_FIXTURE: 'E_UNSEALED_FIXTURE',
  E_SEALED_OBJECT_MISSING: 'E_SEALED_OBJECT_MISSING',
  E_SEALED_OBJECT_CORRUPT: 'E_SEALED_OBJECT_CORRUPT',
  E_FIXTURE_REPO_VISIBLE: 'E_FIXTURE_REPO_VISIBLE',
  E_POOL_TOO_SMALL: 'E_POOL_TOO_SMALL',
  E_CARD_PARSE: 'E_CARD_PARSE',
  E_REFERENCE_NOT_GREEN: 'E_REFERENCE_NOT_GREEN',
  E_MUTANT_NOT_CAUGHT: 'E_MUTANT_NOT_CAUGHT',
  E_BAD_FAIL_SURFACE: 'E_BAD_FAIL_SURFACE',
  E_UNKNOWN_CHECK_ID: 'E_UNKNOWN_CHECK_ID',
  W_POOL_BELOW_MIN: 'W_POOL_BELOW_MIN',
} as const;

interface ValidationIssue {
  code: string;
  role?: string;
  fixture?: string;
  mutantId?: string;
  detail?: string;
}

interface CardCheck {
  id: string;
  category: string;
  disclosure: string;
}

interface CardMutant {
  id: string;
  mutantClass: string;
  expectedDrop: number;
  mustFail: string[];
  fixture: string;
}

interface GateCard {
  gateId: string;
  disclosureDefault: string;
  checks: CardCheck[];
  reference: string;
  poolMin: number;
  poolStatus: string;
  mutants: CardMutant[];
  rotationK: number;
}

// ---------- content addressing + store ----------

// DEFECT.WINDOWS-FS-OPS: renameSync can transiently throw on Windows when an AV
// scanner or concurrent reader briefly holds the target (EPERM/EBUSY/EACCES).
const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_ATTEMPTS = 5;

/** Bounded-retry atomic publish. Content-addressed: a concurrent writer landing first is a win. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (RENAME_RETRY_ERRNOS.has(code) && attempt < RENAME_MAX_ATTEMPTS) continue;
      if (fs.existsSync(to)) return; // same bytes already published under the same hash
      throw e;
    }
  }
}

/** PURE. sha256 hex of a string or Buffer. */
function sha256HexOf(content: Buffer | string): string {
  return createHash('sha256')
    .update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
    .digest('hex');
}

/** PURE. Extract the 64-hex hash from a `sealed:sha256:` URI, else null. */
function parseSealedUri(ref?: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const m = SEALED_URI_RE.exec(ref);
  return m === null ? null : m[1];
}

/** Store root: explicit option > env FERROX_SEALED_STORE > ~/.cache/ferrox/gates/sealed. */
function resolveStoreRoot(opts?: { storeRoot?: unknown }): string {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (typeof o.storeRoot === 'string' && o.storeRoot !== '') return o.storeRoot;
  const env = process.env.FERROX_SEALED_STORE;
  if (typeof env === 'string' && env !== '') return env;
  return path.join(os.homedir(), '.cache', 'ferrox', 'gates', 'sealed');
}

/** PURE given the root. Object path: <root>/sha256/<hh>/<full-64-hex>. */
function objectPathFor(hash: string, storeRoot?: string): string {
  const root = typeof storeRoot === 'string' && storeRoot !== '' ? storeRoot : resolveStoreRoot();
  return path.join(root, 'sha256', hash.slice(0, 2), hash);
}

/** Seal content (inline or from a file) into the store. Idempotent: same bytes, same object. */
function sealPut(opts?: {
  content?: unknown;
  filePath?: unknown;
  storeRoot?: unknown;
}): { ok: true; hash: string; uri: string; path: string } | { ok: false; code: string; detail?: string } {
  const o = opts && typeof opts === 'object' ? opts : {};
  let content: Buffer | null = null;
  if (typeof o.content === 'string') content = Buffer.from(o.content, 'utf8');
  else if (Buffer.isBuffer(o.content)) content = o.content;
  else if (typeof o.filePath === 'string' && o.filePath !== '') {
    try {
      content = fs.readFileSync(o.filePath);
    } catch (e) {
      return { ok: false, code: 'E_SEAL_READ', detail: String((e as Error).message) };
    }
  }
  if (content === null) return { ok: false, code: 'E_SEAL_READ', detail: 'no content or filePath given' };
  const hash = sha256HexOf(content);
  const root = resolveStoreRoot({ storeRoot: o.storeRoot });
  const objectPath = objectPathFor(hash, root);
  try {
    fs.mkdirSync(path.dirname(objectPath), { recursive: true });
    if (!fs.existsSync(objectPath)) {
      const tmp = `${objectPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, content);
      renameWithRetry(tmp, objectPath);
    }
  } catch (e) {
    return { ok: false, code: 'E_SEAL_WRITE', detail: String((e as Error).message) };
  }
  return { ok: true, hash, uri: `sealed:sha256:${hash}`, path: objectPath };
}

/** Read a sealed object. Re-hashes on read: integrity failures fail closed. */
function sealGet(opts?: {
  ref?: unknown;
  storeRoot?: unknown;
}): { ok: true; hash: string; content: Buffer; path: string } | { ok: false; code: string; detail?: string } {
  const o = opts && typeof opts === 'object' ? opts : {};
  const hash =
    parseSealedUri(o.ref) ?? (typeof o.ref === 'string' && /^[0-9a-f]{64}$/.test(o.ref) ? o.ref : null);
  if (hash === null) return { ok: false, code: CODES.E_UNSEALED_FIXTURE, detail: 'not a sealed:sha256: URI' };
  const objectPath = objectPathFor(hash, resolveStoreRoot({ storeRoot: o.storeRoot }));
  let content: Buffer;
  try {
    content = fs.readFileSync(objectPath);
  } catch {
    return { ok: false, code: CODES.E_SEALED_OBJECT_MISSING, detail: hash };
  }
  if (sha256HexOf(content) !== hash) {
    return { ok: false, code: CODES.E_SEALED_OBJECT_CORRUPT, detail: hash };
  }
  return { ok: true, hash, content, path: objectPath };
}

// ---------- repo visibility ----------

function gitLines(repoRoot: string, args: string[]): string[] {
  try {
    const out = execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\0').filter((l) => l !== '');
  } catch {
    return [];
  }
}

/** sha256 every HEAD blob via 1 `git cat-file --batch` pass (git shas are not sha256). */
function headBlobHashes(repoRoot: string, into: Set<string>): void {
  const entries = gitLines(repoRoot, ['ls-tree', '-r', '-z', 'HEAD']);
  const shas: string[] = [];
  for (const entry of entries) {
    // "<mode> <type> <sha>\t<path>"
    const m = /^\d+ blob ([0-9a-f]{40,64})\t/.exec(entry);
    if (m !== null) shas.push(m[1]);
  }
  if (shas.length === 0) return;
  let batch: Buffer;
  try {
    batch = execFileSync('git', ['-C', repoRoot, 'cat-file', '--batch'], {
      input: shas.join('\n') + '\n',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return;
  }
  let offset = 0;
  while (offset < batch.length) {
    const nl = batch.indexOf(0x0a, offset);
    if (nl < 0) break;
    const header = batch.subarray(offset, nl).toString('utf8');
    offset = nl + 1;
    const hm = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (hm === null) continue; // "missing" or unexpected line carries no payload
    const size = parseInt(hm[1], 10);
    into.add(sha256HexOf(batch.subarray(offset, offset + size)));
    offset += size + 1; // payload + trailing newline
  }
}

/**
 * The repo blob hash set: sha256 of every HEAD blob, every tracked working-tree file, and
 * every untracked file under opts.scanDirs (the card's directory per ADR decision 4).
 */
function collectRepoBlobHashes(repoRoot?: unknown, opts?: { scanDirs?: unknown }): Set<string> {
  const hashes = new Set<string>();
  if (typeof repoRoot !== 'string' || repoRoot === '') return hashes;
  const o = opts && typeof opts === 'object' ? opts : {};

  headBlobHashes(repoRoot, hashes);

  for (const rel of gitLines(repoRoot, ['ls-files', '-z'])) {
    try {
      hashes.add(sha256HexOf(fs.readFileSync(path.join(repoRoot, rel))));
    } catch {
      // deleted from the working tree; the HEAD pass already covered its committed content
    }
  }

  const scanDirs = Array.isArray(o.scanDirs)
    ? o.scanDirs.filter((d): d is string => typeof d === 'string' && d !== '')
    : [];
  for (const dir of scanDirs) {
    for (const rel of gitLines(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--', dir])) {
      try {
        hashes.add(sha256HexOf(fs.readFileSync(path.join(repoRoot, rel))));
      } catch {
        // unreadable untracked file: nothing to add
      }
    }
  }
  return hashes;
}

/** PURE. A fixture is repo-visible when its content hash exists in the repo blob set. */
function isRepoVisible(hash?: unknown, repoHashes?: unknown): boolean {
  return typeof hash === 'string' && repoHashes instanceof Set && repoHashes.has(hash);
}

// ---------- card parsing ----------

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function normalizeCard(raw: unknown): GateCard | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const gateId = asString(r.gate_id);
  if (gateId === '') return null;
  const disclosureDefault = asString(r.disclosure_default, 'opaque');

  const checks: CardCheck[] = [];
  if (Array.isArray(r.checks)) {
    for (const c of r.checks) {
      if (c === null || typeof c !== 'object') continue;
      const cc = c as Record<string, unknown>;
      const id = asString(cc.id);
      if (id === '') continue;
      checks.push({
        id,
        category: asString(cc.category),
        disclosure: asString(cc.disclosure, disclosureDefault),
      });
    }
  }

  const v = r.validation !== null && typeof r.validation === 'object' ? (r.validation as Record<string, unknown>) : {};
  const mutants: CardMutant[] = [];
  if (Array.isArray(v.mutants)) {
    for (const m of v.mutants) {
      if (m === null || typeof m !== 'object') continue;
      const mm = m as Record<string, unknown>;
      const id = asString(mm.id);
      if (id === '') continue;
      mutants.push({
        id,
        mutantClass: asString(mm.class),
        expectedDrop:
          typeof mm.expected_drop === 'number' && Number.isFinite(mm.expected_drop) && mm.expected_drop >= 1
            ? Math.floor(mm.expected_drop)
            : 1,
        mustFail: Array.isArray(mm.must_fail)
          ? mm.must_fail.filter((f): f is string => typeof f === 'string' && f !== '')
          : [],
        fixture: asString(mm.fixture),
      });
    }
  }

  return {
    gateId,
    disclosureDefault,
    checks,
    reference: asString(v.reference),
    poolMin:
      typeof v.pool_min === 'number' && Number.isFinite(v.pool_min) && v.pool_min >= 1
        ? Math.floor(v.pool_min)
        : DEFAULT_POOL_MIN,
    poolStatus: asString(v.pool_status, 'seeded'),
    mutants,
    rotationK:
      typeof v.rotation_k === 'number' && Number.isFinite(v.rotation_k) && v.rotation_k >= 1
        ? Math.floor(v.rotation_k)
        : mutantRotation.DEFAULT_ROTATION_K,
  };
}

/** Parse a card markdown document: YAML frontmatter machine block between `---` fences. */
function parseGateCard(markdown?: unknown): { ok: true; card: GateCard } | { ok: false; code: string; detail: string } {
  if (typeof markdown !== 'string' || markdown === '') {
    return { ok: false, code: CODES.E_CARD_PARSE, detail: 'empty card' };
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (m === null) return { ok: false, code: CODES.E_CARD_PARSE, detail: 'no frontmatter block' };
  let raw: unknown;
  try {
    // js-yaml v4 load() is safe by default (DEFAULT_SCHEMA has no code-executing tags;
    // the v3 unsafe loader was removed upstream). Cards are plain scalars/maps/lists.
    raw = yaml.load(m[1]);
  } catch (e) {
    return { ok: false, code: CODES.E_CARD_PARSE, detail: String((e as Error).message) };
  }
  const card = normalizeCard(raw);
  if (card === null) return { ok: false, code: CODES.E_CARD_PARSE, detail: 'missing gate_id or malformed frontmatter' };
  return { ok: true, card };
}

// ---------- validation ----------

interface FixtureRef {
  role: string;
  mutantId?: string;
  ref: string;
  hash: string | null;
  content: Buffer | null;
}

interface RunGateResult {
  score: [number, number];
  fails: string[];
}

type RunGateFn = (opts: { gateCmd: string | string[]; artifactPath: string }) => RunGateResult;

/** Check every emitted FAIL token against the v2 surface and the card inventory. */
function checkFailSurface(card: GateCard, fails: string[], where: string, errors: ValidationIssue[]): void {
  const byId = new Map(card.checks.map((c) => [c.id, c]));
  for (const fail of fails) {
    const cls = gateRunner.classifyFail(fail) as { v2: boolean; id?: string; category?: string };
    if (cls.v2 === true && typeof cls.id === 'string') {
      const check = byId.get(cls.id);
      if (check === undefined) {
        errors.push({ code: CODES.E_UNKNOWN_CHECK_ID, detail: `${where}: ${fail}` });
      } else if (check.category !== cls.category) {
        errors.push({ code: CODES.E_BAD_FAIL_SURFACE, detail: `${where}: ${fail} category mismatch` });
      }
      continue;
    }
    // Non-v2 tokens are allowed ONLY for disclosure-named checks, keyed by leading check id.
    const lead = fail.split(/\s+/, 1)[0];
    const named = byId.get(lead);
    if (named === undefined || named.disclosure !== 'named') {
      errors.push({ code: CODES.E_BAD_FAIL_SURFACE, detail: `${where}: ${fail}` });
    }
  }
}

/** Emitted fail ids for must_fail matching: v2 ids plus leading tokens of named fails. */
function emittedIds(fails: string[]): Set<string> {
  const ids = new Set<string>();
  for (const fail of fails) {
    const cls = gateRunner.classifyFail(fail) as { v2: boolean; id?: string };
    ids.add(cls.v2 === true && typeof cls.id === 'string' ? cls.id : fail.split(/\s+/, 1)[0]);
  }
  return ids;
}

/**
 * The Wave 1 enforcement point. Static seal checks always run; the gate itself runs when
 * opts.gateCmd is provided. Returns { ok, code?, errors, warnings, runRecord }. Never throws.
 */
function validateGateCard(
  cardInput?: unknown,
  opts?: {
    repoRoot?: unknown;
    storeRoot?: unknown;
    runId?: unknown;
    gateCmd?: unknown;
    gateScriptPath?: unknown;
    scanDirs?: unknown;
    runGateFn?: unknown;
  }
): {
  ok: boolean;
  code?: string;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  runRecord: Record<string, unknown> | null;
} {
  const o = opts && typeof opts === 'object' ? opts : {};
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  let card: GateCard | null = null;
  if (typeof cardInput === 'string') {
    const parsed = parseGateCard(cardInput);
    if (parsed.ok === false) {
      return { ok: false, code: parsed.code, errors: [{ code: parsed.code, detail: parsed.detail }], warnings, runRecord: null };
    }
    card = parsed.card;
  } else {
    card = normalizeCard(cardInput);
  }
  if (card === null) {
    return { ok: false, code: CODES.E_CARD_PARSE, errors: [{ code: CODES.E_CARD_PARSE, detail: 'unparseable card' }], warnings, runRecord: null };
  }

  const storeRoot = resolveStoreRoot({ storeRoot: o.storeRoot });

  // 1. Every fixture must be sealed, present, and intact.
  const fixtures: FixtureRef[] = [
    { role: 'reference', ref: card.reference, hash: null, content: null },
    ...card.mutants.map((m) => ({ role: 'mutant', mutantId: m.id, ref: m.fixture, hash: null, content: null })),
  ];
  for (const f of fixtures) {
    const hash = parseSealedUri(f.ref);
    if (hash === null) {
      errors.push({ code: CODES.E_UNSEALED_FIXTURE, role: f.role, mutantId: f.mutantId, fixture: f.ref });
      continue;
    }
    f.hash = hash;
    const got = sealGet({ ref: f.ref, storeRoot });
    if (got.ok === false) {
      errors.push({ code: got.code, role: f.role, mutantId: f.mutantId, fixture: f.ref });
      continue;
    }
    f.content = got.content;
  }

  // 2. Pool floor: only fluent-but-wrong mutants count (garbled entries are smoke only).
  const fluent = card.mutants.filter((m) => m.mutantClass === FLUENT_CLASS);
  if (fluent.length < POOL_MIGRATION_FLOOR) {
    errors.push({
      code: CODES.E_POOL_TOO_SMALL,
      detail: `fluent pool ${fluent.length} < migration floor ${POOL_MIGRATION_FLOOR}`,
    });
  } else if (fluent.length < card.poolMin) {
    warnings.push({
      code: CODES.W_POOL_BELOW_MIN,
      detail: `fluent pool ${fluent.length} < pool_min ${card.poolMin}`,
    });
  }

  // 3. Repo visibility: sealing a repo-visible file must not launder it.
  if (typeof o.repoRoot === 'string' && o.repoRoot !== '') {
    const repoHashes = collectRepoBlobHashes(o.repoRoot, { scanDirs: o.scanDirs ?? ['.'] });
    for (const f of fixtures) {
      if (f.hash !== null && isRepoVisible(f.hash, repoHashes)) {
        errors.push({ code: CODES.E_FIXTURE_REPO_VISIBLE, role: f.role, mutantId: f.mutantId, fixture: f.ref });
      }
    }
  }

  const failNow = (): { ok: boolean; code?: string; errors: ValidationIssue[]; warnings: ValidationIssue[]; runRecord: Record<string, unknown> | null } => ({
    ok: false,
    code: errors.some((e) => e.code === CODES.E_FIXTURE_REPO_VISIBLE) ? CODES.E_FIXTURE_REPO_VISIBLE : errors[0]?.code,
    errors,
    warnings,
    runRecord: null,
  });
  if (errors.length > 0) return failNow();

  // 4. Per-run mutant sample (ADR decision 2). Replay with the same runId reproduces it.
  const runId = typeof o.runId === 'string' && o.runId !== '' ? o.runId : mutantRotation.mintRunId();
  const sample = mutantRotation.sampleMutants({
    runId,
    gateId: card.gateId,
    pool: fluent.map((m) => ({ id: m.id, fixture: m.fixture })),
    k: card.rotationK,
  });
  const referenceHash = fixtures[0].hash as string;
  const sampledRecords: Array<{ id: string; hash: string; score?: [number, number]; fails?: string[] }> =
    sample.sampled.map((s) => ({ ...s }));
  const runRecord: Record<string, unknown> = {
    runId,
    gateId: card.gateId,
    referenceHash,
    sampled: sampledRecords,
  };
  if (typeof o.gateScriptPath === 'string' && o.gateScriptPath !== '') {
    try {
      runRecord.gateScriptHash = sha256HexOf(fs.readFileSync(o.gateScriptPath));
    } catch {
      // no gate script hash when the path is unreadable; the run record stays usable
    }
  }

  // 5. Dynamic assertions: run the sealed gate against reference + sampled mutants.
  const gateCmd = o.gateCmd;
  const hasGateCmd =
    (typeof gateCmd === 'string' && gateCmd !== '') || (Array.isArray(gateCmd) && gateCmd.length > 0);
  if (hasGateCmd) {
    const runGateFn: RunGateFn =
      typeof o.runGateFn === 'function' ? (o.runGateFn as RunGateFn) : gateRunner.runGate;
    const byId = new Map(card.mutants.map((m) => [m.id, m]));
    const contentByHash = new Map(fixtures.filter((f) => f.hash !== null && f.content !== null).map((f) => [f.hash as string, f.content as Buffer]));
    let tmpDir: string | null = null;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-seal-run-'));
      const runOn = (hash: string, name: string): RunGateResult => {
        const artifactPath = path.join(tmpDir as string, name);
        fs.writeFileSync(artifactPath, contentByHash.get(hash) ?? Buffer.alloc(0));
        return runGateFn({ gateCmd: gateCmd as string | string[], artifactPath });
      };

      const refResult = runOn(referenceHash, 'reference.artifact');
      checkFailSurface(card, refResult.fails, 'reference', errors);
      if (refResult.fails.length > 0 || refResult.score[0] !== refResult.score[1] || refResult.score[1] < 1) {
        errors.push({
          code: CODES.E_REFERENCE_NOT_GREEN,
          detail: `reference scored ${refResult.score[0]}/${refResult.score[1]} with ${refResult.fails.length} fails`,
        });
      }
      runRecord.referenceScore = refResult.score;

      for (const s of sampledRecords) {
        const mutant = byId.get(s.id);
        if (mutant === undefined) continue;
        const result = runOn(s.hash, `mutant-${s.id}.artifact`);
        checkFailSurface(card, result.fails, `mutant ${s.id}`, errors);
        s.score = result.score;
        s.fails = [...result.fails];
        const drop = result.fails.length;
        const ids = emittedIds(result.fails);
        const missing = mutant.mustFail.filter((id) => !ids.has(id));
        if (drop < mutant.expectedDrop || missing.length > 0) {
          errors.push({
            code: CODES.E_MUTANT_NOT_CAUGHT,
            mutantId: mutant.id,
            detail:
              drop < mutant.expectedDrop
                ? `dropped ${drop} < expected_drop ${mutant.expectedDrop}`
                : `must_fail ids not emitted: ${missing.join(', ')}`,
          });
        }
      }
    } catch (e) {
      errors.push({ code: CODES.E_REFERENCE_NOT_GREEN, detail: `gate run failed: ${String((e as Error).message)}` });
    } finally {
      if (tmpDir !== null) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best-effort temp cleanup
        }
      }
    }
  }

  if (errors.length > 0) {
    const failed = failNow();
    failed.runRecord = runRecord;
    return failed;
  }
  return { ok: true, errors, warnings, runRecord };
}

export = {
  sha256HexOf,
  parseSealedUri,
  resolveStoreRoot,
  objectPathFor,
  sealPut,
  sealGet,
  collectRepoBlobHashes,
  isRepoVisible,
  parseGateCard,
  validateGateCard,
  CODES,
  POOL_MIGRATION_FLOOR,
  DEFAULT_POOL_MIN,
};
