/**
 * UGE-03 — the canonical gate contract (ANVIL-PORT-SPEC.md §2), two layers.
 *
 * PURE: parseGateOutput(stdout) -> { score:[n,m], fails:string[] }
 *   - summary regex `(?:[a-z0-9-]*gate|gate):\s*(\d+)\s*\/\s*(\d+)` — LAST match wins (retries and
 *     partial re-runs print multiple summaries; the final one is the verdict).
 *   - one fail per line starting `FAIL ` — the FULL check name after the marker, untruncated
 *     (the climb loop's tried-memory is keyed on this exact string).
 *   - no summary line -> { score:[0,1], fails:['<no gate output>'] }. FAIL CLOSED: a gate that
 *     crashed, printed garbage, or said nothing is a failing gate, never a passing one.
 *
 * IMPURE thin wrapper: runGate({ gateCmd, artifactPath, timeoutMs }) — the ONLY I/O in the UGE
 * pure-core wave. Safety pattern copied from anvil-executor.cts runAnvil:
 *   - execFileSync with an argv array (NO shell string) -> no injection surface;
 *   - exit code deliberately NOT the verdict (gates exit nonzero on failing checks and we still
 *     want the parsed score); stdout is captured either way and parsed;
 *   - timeout (default 400s per spec §2) -> { score:[0,1], fails:['<gate timeout>'] };
 *   - any spawn error -> fail-closed shape. Never throws.
 *
 * Trust boundary (spec §4): the gate is authored by the ORCHESTRATOR side, never a builder model.
 * The parsed check identifiers are the ONLY feedback that may reach a builder — never gate source,
 * never expected values. This module returns exactly that: identifiers and a score.
 * ADR-457: compiles to ferrox-core/bin/lib/gate-runner.cjs. `export =` shape.
 */

import { execFileSync } from 'node:child_process';

interface GateResult {
  score: [number, number];
  fails: string[];
}

/** Spec §2 invocation timeout: 400s. */
const DEFAULT_TIMEOUT_MS = 400000;

/**
 * FAIL surface v2 (ADR-SEALED-GATES decision 3): `FAIL <ID> <category>` where ID matches
 * ^[A-Z]{2,4}-[0-9]{2}$ and category is the closed 6-enum below. The FULL "<ID> <category>"
 * string stays the stable check key (gate-climb tried-memory is keyed on it unchanged);
 * classifyFail is the validator gate validation uses to assert a card-conformant surface.
 */
const FAIL_CATEGORIES = ['structure', 'value', 'relation', 'grounding', 'execution', 'security'] as const;
const FAIL_V2_RE = /^([A-Z]{2,4}-[0-9]{2})[ \t]+(structure|value|relation|grounding|execution|security)$/;

type FailClass = { v2: true; id: string; category: string } | { v2: false };

/** PURE. Classify a parsed fail string: v2 `<ID> <category>` token or legacy name. Never throws. */
function classifyFail(fail?: unknown): FailClass {
  if (typeof fail !== 'string') return { v2: false };
  const m = FAIL_V2_RE.exec(fail);
  if (m === null) return { v2: false };
  return { v2: true, id: m[1], category: m[2] };
}

/**
 * PURE. Normalize a fail string: v2 lines with irregular inner whitespace collapse to the
 * canonical `<ID> <category>` single-space form so the tried-memory key is stable across
 * gate emitters. Legacy names pass through untouched.
 */
function normalizeFail(fail: string): string {
  const m = FAIL_V2_RE.exec(fail);
  return m === null ? fail : `${m[1]} ${m[2]}`;
}

/** The fail-closed verdict: no usable gate output means the gate did not pass. */
function failClosed(reason: string): GateResult {
  return { score: [0, 1], fails: [reason] };
}

/**
 * PURE. Parse canonical gate stdout. Summary regex per spec §2, LAST match wins; every line
 * starting `FAIL ` contributes its full check name. No summary -> fail closed.
 */
function parseGateOutput(stdout?: unknown): GateResult {
  if (typeof stdout !== 'string' || stdout === '') return failClosed('<no gate output>');

  const summaryRe = /(?:[a-z0-9-]*gate|gate):\s*(\d+)\s*\/\s*(\d+)/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = summaryRe.exec(stdout)) !== null) {
    last = m;
  }
  if (last === null) return failClosed('<no gate output>');

  const fails: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('FAIL ')) {
      const name = line.slice('FAIL '.length).replace(/[\r\s]+$/, '');
      if (name !== '') fails.push(normalizeFail(name));
    }
  }
  return { score: [parseInt(last[1], 10), parseInt(last[2], 10)], fails };
}

/**
 * IMPURE. Run `<gate_cmd> <artifact_path>` (subprocess, no shell) and parse its stdout.
 * `gateCmd` is a binary path or an argv array (e.g. ['python3', 'gate.py']); the artifact path is
 * always appended as the final argv token. Never throws — every failure path fails closed.
 */
function runGate(opts?: { gateCmd?: string | string[]; artifactPath?: string; timeoutMs?: number }): GateResult {
  const o = opts && typeof opts === 'object' ? opts : {};
  const cmdArr = Array.isArray(o.gateCmd)
    ? o.gateCmd.filter((t): t is string => typeof t === 'string' && t !== '')
    : typeof o.gateCmd === 'string' && o.gateCmd !== ''
      ? [o.gateCmd]
      : [];
  if (cmdArr.length === 0 || typeof o.artifactPath !== 'string' || o.artifactPath === '') {
    return failClosed('<no gate output>');
  }
  const timeoutMs =
    typeof o.timeoutMs === 'number' && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0
      ? o.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  let stdout = '';
  try {
    // NO shell — argv array (anvil-executor safety pattern). Throws on nonzero exit AND on
    // timeout/spawn errors; nonzero exit still carries stdout, which is the real verdict.
    stdout = execFileSync(cmdArr[0], [...cmdArr.slice(1), o.artifactPath], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { code?: unknown; signal?: unknown; stdout?: unknown };
    if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM' || err.signal === 'SIGKILL') {
      return failClosed('<gate timeout>');
    }
    stdout = typeof err.stdout === 'string' ? err.stdout : '';
  }
  return parseGateOutput(stdout);
}

export = {
  parseGateOutput,
  runGate,
  classifyFail,
  DEFAULT_TIMEOUT_MS,
  FAIL_CATEGORIES: [...FAIL_CATEGORIES] as string[],
};
