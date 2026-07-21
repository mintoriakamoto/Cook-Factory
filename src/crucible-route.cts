/**
 * UGE-07 — the consume-only Crucible adapter (ANVIL-PORT-SPEC.md §6).
 *
 * Crucible is `wayland-core crucible "<prompt>"` — a judge-panel fusion engine Factory CONSUMES,
 * never embeds: Tier-6 territory + the fallback for ungated domains. This module is the whole
 * integration surface:
 *
 *   probeCrucibleAvailable({ binaryPath? }) -> boolean
 *     Explicit path -> fs existence check; default candidate `wayland-core` -> PATH lookup only
 *     (nothing is ever executed by the probe). Never throws. Absent -> the router falls through
 *     to the normal executor (fail-safe).
 *
 *   runCrucible({ prompt, binaryPath?, timeoutMs?, workdir?, configToml?, retries? })
 *     -> { ok, text, stderr, reason }
 *     - argv array, NO shell (spawnSync shell:false — the same no-shell no-injection property as
 *       the anvil-executor execFileSync pattern, chosen because it also surfaces stderr on
 *       success: crucible prints per-member spend there);
 *     - stdin IGNORED (closed), isolated workdir (caller-provided or a fresh OS tmpdir — never
 *       the process cwd);
 *     - ~240s default timeout; timeout/spawn-fail -> { ok:false, reason } — NEVER throws;
 *     - exit code is NOT the verdict (stdout is consumed either way, anvil pattern);
 *     - text = the LARGEST fenced code block in stdout, else the full stdout;
 *     - retries (default 0 — retry policy belongs to the caller, spec caps at 4) re-invoke on
 *       no-usable-output only.
 *
 * SECRET BOUNDARY: this module ships NO model-routing internals — no member list, no aggregator
 * choice, no pricing. An optional `configToml` string comes from the CALLER and is written into
 * the isolated workdir (config.toml) only when provided.
 *
 * ADR-457: compiles to ferrox-core/bin/lib/crucible-route.cjs. `export =` shape. Never throws.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';

interface CrucibleResult {
  ok: boolean;
  text: string;
  stderr: string;
  reason: string;
}

const DEFAULT_BINARY = 'wayland-core';
/** Spec §6: ~240s for a full panel deliberation. */
const DEFAULT_TIMEOUT_MS = 240000;
/** Spec §6 caps retries at 4; the default here is 0 — retry policy belongs to the caller. */
const MAX_RETRIES = 4;

/** True if `bin` resolves on PATH — a lookup only; the binary is never executed. */
function hasOnPath(bin: string): boolean {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (d === '') continue;
    try {
      if (fs.existsSync(path.join(d, bin))) return true;
    } catch {
      /* ignore unreadable PATH entry */
    }
  }
  return false;
}

/**
 * IMPURE (fs lookup only — nothing is executed). Is a crucible binary reachable?
 * Explicit path -> existence check; otherwise the default candidate is probed on PATH.
 * Never throws.
 */
function probeCrucibleAvailable(opts?: { binaryPath?: unknown }): boolean {
  const o = opts && typeof opts === 'object' ? opts : {};
  try {
    if (typeof o.binaryPath === 'string' && o.binaryPath !== '') {
      return fs.existsSync(o.binaryPath) && fs.statSync(o.binaryPath).isFile();
    }
    if (o.binaryPath !== undefined) return false; // garbage explicit path -> not available
    return hasOnPath(DEFAULT_BINARY);
  } catch {
    return false;
  }
}

/** The LARGEST fenced code block in stdout (fused answers arrive fenced), else null. */
function extractLargestFencedBlock(stdout: string): string | null {
  // allow-adhoc-markdown: fused-answer extraction needs the LARGEST block with ANY info string; the sectionizer's extractFencedBlock is info-string-keyed and stripFencedCode discards block content
  const re = /```[^\n]*\n?([\s\S]*?)```/g;
  let largest: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    const block = m[1].replace(/\n+$/, '');
    if (largest === null || block.length > largest.length) largest = block;
  }
  return largest;
}

/**
 * IMPURE. Run one crucible fusion, consume-only, fail-safe. NEVER throws — every failure path
 * resolves to { ok:false, reason } so the router can fall through to the normal executor.
 */
function runCrucible(opts?: {
  prompt?: unknown;
  binaryPath?: unknown;
  timeoutMs?: unknown;
  workdir?: unknown;
  configToml?: unknown;
  retries?: unknown;
}): CrucibleResult {
  const o = opts && typeof opts === 'object' ? opts : {};
  const fail = (reason: string, stderr = ''): CrucibleResult => ({ ok: false, text: '', stderr, reason });

  const prompt = typeof o.prompt === 'string' ? o.prompt : '';
  if (prompt === '') return fail('no-prompt');

  // undefined -> the default candidate; a PRESENT-but-garbage path never falls back silently.
  const binary =
    o.binaryPath === undefined ? DEFAULT_BINARY : typeof o.binaryPath === 'string' && o.binaryPath !== '' ? o.binaryPath : '';
  if (binary === '') return fail('spawn-failed');

  const timeoutMs =
    typeof o.timeoutMs === 'number' && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  const retries =
    typeof o.retries === 'number' && Number.isFinite(o.retries) && o.retries > 0
      ? Math.min(Math.floor(o.retries), MAX_RETRIES)
      : 0;

  let workdir: string;
  try {
    if (typeof o.workdir === 'string' && o.workdir !== '') {
      fs.mkdirSync(o.workdir, { recursive: true });
      workdir = o.workdir;
    } else {
      workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-'));
    }
    // Caller-provided config ONLY — this module knows no model-routing internals to write.
    if (typeof o.configToml === 'string' && o.configToml !== '') {
      fs.writeFileSync(path.join(workdir, 'config.toml'), o.configToml);
    }
  } catch {
    return fail('workdir-error');
  }

  let last: CrucibleResult = fail('no-output');
  for (let attempt = 0; attempt <= retries; attempt++) {
    let result: childProcess.SpawnSyncReturns<string>;
    try {
      // argv array, shell:false — the prompt is NEVER shell-interpolated. stdin closed.
      result = childProcess.spawnSync(binary, ['crucible', prompt], {
        shell: false,
        cwd: workdir,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
    } catch {
      last = fail('spawn-failed');
      continue;
    }

    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    const err: (Error & { code?: string }) | undefined = result.error;
    if (err) {
      const timedOut = err.code === 'ETIMEDOUT' || result.signal === 'SIGTERM' || result.signal === 'SIGKILL';
      last = fail(timedOut ? 'timeout' : 'spawn-failed', stderr);
      continue;
    }

    // Exit code is NOT the verdict — consume stdout either way (anvil pattern).
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const text = extractLargestFencedBlock(stdout) ?? stdout.trim();
    if (text !== '') return { ok: true, text, stderr, reason: 'ok' };
    last = fail('no-output', stderr);
  }
  return last;
}

export = { probeCrucibleAvailable, runCrucible, DEFAULT_TIMEOUT_MS };
