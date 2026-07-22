/**
 * MILESTONE v1.10 wave 1 visual companion verbs: visual.start, visual.stop,
 * visual.status.
 *
 * Thin CLI seam over the adapted visual companion server that lives in
 * ferrox-core/bin/visual/ (adapted from Superpowers by Obra, MIT). The server
 * protocol is file-based: start-server.sh prints a server-started JSON
 * handshake ({type, port, host, url_host, url, screen_dir, state_dir}) and
 * mirrors it to <session>/state/server-info; user click selections land as
 * JSON lines in <session>/state/events; stop-server.sh prints
 * {"status":"stopped"} or {"status":"not_running"}.
 *
 * visual.start  --project-dir <path> [--session <name>] [--port <n>]
 *               [--host <h>] [--url-host <h>]   prints the handshake JSON.
 * visual.status [--session-dir <path> | --project-dir <path>]
 *               reports running state, port, screen_dir, and the last
 *               recorded selection event.
 * visual.stop   [--session-dir <path> | --project-dir <path>]
 *               kills the server cleanly; a second stop is a clean no-op.
 *
 * With --project-dir, sessions persist under
 * <project>/.planning/brainstorms/<session>/ (screens/ + state/), so every
 * mockup shown is part of the brainstorm record (locked decision 6).
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/visual-command-router.cjs.
 */

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { VISUAL_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;

interface RouteVisualCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
}

const VISUAL_SCRIPTS_DIR = path.join(__dirname, '..', 'visual');

function parseFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function emit(result: unknown, raw: boolean): void {
  process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}

function lastJsonLine(text: string): unknown {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep scanning upward for the last parseable JSON line
    }
  }
  return undefined;
}

function brainstormsRoot(projectDir: string): string {
  return path.join(projectDir, '.planning', 'brainstorms');
}

/**
 * Resolve the session directory: --session-dir wins; otherwise the newest
 * session under <project>/.planning/brainstorms/ that has a state/ dir.
 */
function resolveSessionDir(args: string[], cwd: string): string | null {
  const explicit = parseFlag(args, '--session-dir');
  if (explicit) return path.resolve(cwd, explicit);

  const projectDir = parseFlag(args, '--project-dir');
  if (!projectDir) return null;
  const root = brainstormsRoot(path.resolve(cwd, projectDir));
  if (!fs.existsSync(root)) return null;

  let newest: { dir: string; mtime: number } | null = null;
  for (const entry of fs.readdirSync(root)) {
    const dir = path.join(root, entry);
    const stateDir = path.join(dir, 'state');
    try {
      if (!fs.statSync(dir).isDirectory() || !fs.existsSync(stateDir)) continue;
      const mtime = fs.statSync(stateDir).mtime.getTime();
      if (!newest || mtime > newest.mtime) newest = { dir, mtime };
    } catch {
      // unreadable entry: skip
    }
  }
  return newest ? newest.dir : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function handleStart(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const scriptArgs: string[] = [path.join(VISUAL_SCRIPTS_DIR, 'start-server.sh')];
  const projectDir = parseFlag(args, '--project-dir');
  if (projectDir) scriptArgs.push('--project-dir', path.resolve(cwd, projectDir));
  for (const flag of ['--session', '--port', '--host', '--url-host'] as const) {
    const value = parseFlag(args, flag);
    if (value !== undefined) scriptArgs.push(flag, value);
  }

  const res = childProcess.spawnSync('bash', scriptArgs, { encoding: 'utf8', shell: false });
  if (res.error) {
    error(`visual.start failed to spawn: ${res.error.message}`);
    return;
  }
  const parsed = lastJsonLine(res.stdout || '');
  if (res.status !== 0) {
    const detail = parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)
      ? String((parsed as Record<string, unknown>).error)
      : (res.stderr || res.stdout || 'unknown failure').trim();
    error(`visual.start failed: ${detail}`);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as Record<string, unknown>).type !== 'server-started') {
    error(`visual.start: no server-started handshake in output: ${(res.stdout || '').trim()}`);
    return;
  }
  emit(parsed, raw);
}

function handleStatus(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const sessionDir = resolveSessionDir(args, cwd);
  if (!sessionDir) {
    if (!parseFlag(args, '--session-dir') && !parseFlag(args, '--project-dir')) {
      error('Usage: ferrox-tools query visual.status --session-dir <path> | --project-dir <path>');
      return;
    }
    emit({ running: false, reason: 'no session found' }, raw);
    return;
  }

  const stateDir = path.join(sessionDir, 'state');
  const infoPath = path.join(stateDir, 'server-info');
  const stoppedPath = path.join(stateDir, 'server-stopped');
  const pidPath = path.join(stateDir, 'server.pid');
  const eventsPath = path.join(stateDir, 'events');

  let info: Record<string, unknown> | undefined;
  if (fs.existsSync(infoPath)) {
    const parsed = lastJsonLine(fs.readFileSync(infoPath, 'utf8'));
    if (parsed && typeof parsed === 'object') info = parsed as Record<string, unknown>;
  }

  let pid: number | null = null;
  if (fs.existsSync(pidPath)) {
    const n = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (Number.isFinite(n)) pid = n;
  }

  let lastEvent: unknown = null;
  if (fs.existsSync(eventsPath)) {
    lastEvent = lastJsonLine(fs.readFileSync(eventsPath, 'utf8')) ?? null;
  }

  const running = info !== undefined && pid !== null && pidAlive(pid);
  const result: Record<string, unknown> = {
    running,
    session_dir: sessionDir,
    pid,
    port: info ? info.port ?? null : null,
    url: info ? info.url ?? null : null,
    screen_dir: info ? info.screen_dir ?? path.join(sessionDir, 'screens') : path.join(sessionDir, 'screens'),
    state_dir: stateDir,
    last_event: lastEvent,
  };
  if (!running && fs.existsSync(stoppedPath)) {
    const stopped = lastJsonLine(fs.readFileSync(stoppedPath, 'utf8'));
    if (stopped && typeof stopped === 'object') {
      result.stopped_reason = (stopped as Record<string, unknown>).reason ?? null;
    }
  }
  emit(result, raw);
}

function handleStop(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const sessionDir = resolveSessionDir(args, cwd);
  if (!sessionDir) {
    if (!parseFlag(args, '--session-dir') && !parseFlag(args, '--project-dir')) {
      error('Usage: ferrox-tools query visual.stop --session-dir <path> | --project-dir <path>');
      return;
    }
    emit({ status: 'not_running' }, raw);
    return;
  }

  const res = childProcess.spawnSync(
    'bash',
    [path.join(VISUAL_SCRIPTS_DIR, 'stop-server.sh'), sessionDir],
    { encoding: 'utf8', shell: false },
  );
  if (res.error) {
    error(`visual.stop failed to spawn: ${res.error.message}`);
    return;
  }
  const parsed = lastJsonLine(res.stdout || '');
  if (res.status !== 0) {
    const detail = parsed ? JSON.stringify(parsed) : (res.stderr || res.stdout || 'unknown failure').trim();
    error(`visual.stop failed: ${detail}`);
    return;
  }
  emit(parsed ?? { status: 'not_running' }, raw);
}

function routeVisualCommand({ args, cwd, raw, error }: RouteVisualCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: VISUAL_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_s: string, available: string[]) => `Unknown visual subcommand. Available: ${available.join(', ')}`,
    handlers: {
      'start': () => handleStart(args, cwd, raw, error),
      'stop': () => handleStop(args, cwd, raw, error),
      'status': () => handleStatus(args, cwd, raw, error),
    },
  });
}

export = { routeVisualCommand };
