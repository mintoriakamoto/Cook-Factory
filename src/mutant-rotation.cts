/**
 * SEAL-02: per-run mutant rotation (ADR-SEALED-GATES decision 2, pinned byte-for-byte).
 *
 * PURE deterministic sampling. A gate's mutant pool (N >= 5 for new packs, >= 2 during
 * migration) is sampled K at a time per validation run, without replacement, so a builder
 * class that memorizes 1 mutant still meets the rest of the pool across runs.
 *
 * The pinned algorithm (Wave 1, locked by tests/gate-seal-selftest.test.cjs Test C):
 *   1. seed0 = sha256(utf8(runId + ":" + gateId)) as raw bytes.
 *   2. Candidate order: pool mutants sorted lexicographically by fixture hash (input order
 *      is deliberately irrelevant; the hash is the identity).
 *   3. Draw i (0-based): u = first 8 bytes of sha256(seed0 || uint32BE(i)) read as a
 *      big-endian uint64; pick index u % remaining, remove, repeat until K drawn.
 *
 * Run-record shape: { runId, gateId, sampled: [{ id, hash }] }. Re-verification replays
 * with the recorded runId and reproduces the identical sample, so a third party with
 * store access can re-derive the verdict (ADR decision 2).
 *
 * ADR-457: compiles to ferrox-core/bin/lib/mutant-rotation.cjs. `export =` shape.
 * Never throws: garbage inputs fail toward an empty sample.
 */

import { createHash, randomBytes } from 'node:crypto';

interface PoolEntry {
  id: string;
  hash: string;
}

interface RunRecord {
  runId: string;
  gateId: string;
  sampled: PoolEntry[];
}

const DEFAULT_ROTATION_K = 2;
const SEALED_URI_RE = /^sealed:sha256:([0-9a-f]{64})$/;
const BARE_HASH_RE = /^[0-9a-f]{64}$/;

function sha256Bytes(input: Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

/** Accept `sealed:sha256:<64 hex>` URIs or bare 64-hex hashes; anything else is invalid. */
function fixtureHash(fixture: unknown): string | null {
  if (typeof fixture !== 'string') return null;
  const m = SEALED_URI_RE.exec(fixture);
  if (m !== null) return m[1];
  return BARE_HASH_RE.test(fixture) ? fixture : null;
}

/** Normalize an arbitrary pool payload into valid { id, hash } entries. */
function normalizePool(raw: unknown): PoolEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PoolEntry[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as { id?: unknown; fixture?: unknown; hash?: unknown };
    const id = typeof e.id === 'string' && e.id !== '' ? e.id : null;
    const hash = fixtureHash(e.fixture) ?? fixtureHash(e.hash);
    if (id !== null && hash !== null) out.push({ id, hash });
  }
  return out;
}

/**
 * PURE. The pinned per-run sample (ADR decision 2). Same (runId, gateId, pool) always
 * yields the identical K-member sample; K defaults to 2 and clamps to the pool size.
 */
function sampleMutants(opts?: {
  runId?: unknown;
  gateId?: unknown;
  pool?: unknown;
  k?: unknown;
}): RunRecord {
  const o = opts && typeof opts === 'object' ? opts : {};
  const runId = typeof o.runId === 'string' ? o.runId : '';
  const gateId = typeof o.gateId === 'string' ? o.gateId : '';
  const pool = normalizePool(o.pool);
  const k =
    typeof o.k === 'number' && Number.isFinite(o.k) && o.k >= 1
      ? Math.min(Math.floor(o.k), pool.length)
      : Math.min(DEFAULT_ROTATION_K, pool.length);

  if (runId === '' || gateId === '' || pool.length === 0) {
    return { runId, gateId, sampled: [] };
  }

  const seed0 = sha256Bytes(Buffer.from(`${runId}:${gateId}`, 'utf8'));
  const remaining = [...pool].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const sampled: PoolEntry[] = [];
  for (let i = 0; i < k && remaining.length > 0; i++) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(i, 0);
    const draw = sha256Bytes(Buffer.concat([seed0, counter]));
    const u = draw.readBigUInt64BE(0);
    const index = Number(u % BigInt(remaining.length));
    sampled.push(remaining.splice(index, 1)[0]);
  }
  return { runId, gateId, sampled };
}

/**
 * Mint a run id when the caller has none: iso timestamp + "-" + 4 random hex chars
 * (ADR decision 2). `now` and `randomHex` are injectable for deterministic tests.
 */
function mintRunId(opts?: { now?: () => Date; randomHex?: () => string }): string {
  const o = opts && typeof opts === 'object' ? opts : {};
  let iso: string;
  try {
    iso = (typeof o.now === 'function' ? o.now() : new Date()).toISOString();
  } catch {
    iso = new Date().toISOString();
  }
  let hex: string;
  try {
    hex = typeof o.randomHex === 'function' ? o.randomHex() : randomBytes(2).toString('hex');
  } catch {
    hex = randomBytes(2).toString('hex');
  }
  return `${iso}-${hex}`;
}

export = { sampleMutants, mintRunId, DEFAULT_ROTATION_K };
