"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_child_process_1 = __importDefault(require("node:child_process"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const command_aliases_cjs_1 = require("./command-aliases.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cjsCommandRouterAdapter = require("./cjs-command-router-adapter.cjs");
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
const VISUAL_SCRIPTS_DIR = node_path_1.default.join(__dirname, '..', 'visual');
function parseFlag(args, flag) {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function emit(result, raw) {
    process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}
function lastJsonLine(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            return JSON.parse(lines[i]);
        }
        catch {
            // keep scanning upward for the last parseable JSON line
        }
    }
    return undefined;
}
function brainstormsRoot(projectDir) {
    return node_path_1.default.join(projectDir, '.planning', 'brainstorms');
}
/**
 * Resolve the session directory: --session-dir wins; otherwise the newest
 * session under <project>/.planning/brainstorms/ that has a state/ dir.
 */
function resolveSessionDir(args, cwd) {
    const explicit = parseFlag(args, '--session-dir');
    if (explicit)
        return node_path_1.default.resolve(cwd, explicit);
    const projectDir = parseFlag(args, '--project-dir');
    if (!projectDir)
        return null;
    const root = brainstormsRoot(node_path_1.default.resolve(cwd, projectDir));
    if (!node_fs_1.default.existsSync(root))
        return null;
    let newest = null;
    for (const entry of node_fs_1.default.readdirSync(root)) {
        const dir = node_path_1.default.join(root, entry);
        const stateDir = node_path_1.default.join(dir, 'state');
        try {
            if (!node_fs_1.default.statSync(dir).isDirectory() || !node_fs_1.default.existsSync(stateDir))
                continue;
            const mtime = node_fs_1.default.statSync(stateDir).mtime.getTime();
            if (!newest || mtime > newest.mtime)
                newest = { dir, mtime };
        }
        catch {
            // unreadable entry: skip
        }
    }
    return newest ? newest.dir : null;
}
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
}
function handleStart(args, cwd, raw, error) {
    const scriptArgs = [node_path_1.default.join(VISUAL_SCRIPTS_DIR, 'start-server.sh')];
    const projectDir = parseFlag(args, '--project-dir');
    if (projectDir)
        scriptArgs.push('--project-dir', node_path_1.default.resolve(cwd, projectDir));
    for (const flag of ['--session', '--port', '--host', '--url-host']) {
        const value = parseFlag(args, flag);
        if (value !== undefined)
            scriptArgs.push(flag, value);
    }
    const res = node_child_process_1.default.spawnSync('bash', scriptArgs, { encoding: 'utf8', shell: false });
    if (res.error) {
        error(`visual.start failed to spawn: ${res.error.message}`);
        return;
    }
    const parsed = lastJsonLine(res.stdout || '');
    if (res.status !== 0) {
        const detail = parsed && typeof parsed === 'object' && 'error' in parsed
            ? String(parsed.error)
            : (res.stderr || res.stdout || 'unknown failure').trim();
        error(`visual.start failed: ${detail}`);
        return;
    }
    if (!parsed || typeof parsed !== 'object' || parsed.type !== 'server-started') {
        error(`visual.start: no server-started handshake in output: ${(res.stdout || '').trim()}`);
        return;
    }
    emit(parsed, raw);
}
function handleStatus(args, cwd, raw, error) {
    const sessionDir = resolveSessionDir(args, cwd);
    if (!sessionDir) {
        if (!parseFlag(args, '--session-dir') && !parseFlag(args, '--project-dir')) {
            error('Usage: ferrox-tools query visual.status --session-dir <path> | --project-dir <path>');
            return;
        }
        emit({ running: false, reason: 'no session found' }, raw);
        return;
    }
    const stateDir = node_path_1.default.join(sessionDir, 'state');
    const infoPath = node_path_1.default.join(stateDir, 'server-info');
    const stoppedPath = node_path_1.default.join(stateDir, 'server-stopped');
    const pidPath = node_path_1.default.join(stateDir, 'server.pid');
    const eventsPath = node_path_1.default.join(stateDir, 'events');
    let info;
    if (node_fs_1.default.existsSync(infoPath)) {
        const parsed = lastJsonLine(node_fs_1.default.readFileSync(infoPath, 'utf8'));
        if (parsed && typeof parsed === 'object')
            info = parsed;
    }
    let pid = null;
    if (node_fs_1.default.existsSync(pidPath)) {
        const n = Number(node_fs_1.default.readFileSync(pidPath, 'utf8').trim());
        if (Number.isFinite(n))
            pid = n;
    }
    let lastEvent = null;
    if (node_fs_1.default.existsSync(eventsPath)) {
        lastEvent = lastJsonLine(node_fs_1.default.readFileSync(eventsPath, 'utf8')) ?? null;
    }
    const running = info !== undefined && pid !== null && pidAlive(pid);
    const result = {
        running,
        session_dir: sessionDir,
        pid,
        port: info ? info.port ?? null : null,
        url: info ? info.url ?? null : null,
        screen_dir: info ? info.screen_dir ?? node_path_1.default.join(sessionDir, 'screens') : node_path_1.default.join(sessionDir, 'screens'),
        state_dir: stateDir,
        last_event: lastEvent,
    };
    if (!running && node_fs_1.default.existsSync(stoppedPath)) {
        const stopped = lastJsonLine(node_fs_1.default.readFileSync(stoppedPath, 'utf8'));
        if (stopped && typeof stopped === 'object') {
            result.stopped_reason = stopped.reason ?? null;
        }
    }
    emit(result, raw);
}
function handleStop(args, cwd, raw, error) {
    const sessionDir = resolveSessionDir(args, cwd);
    if (!sessionDir) {
        if (!parseFlag(args, '--session-dir') && !parseFlag(args, '--project-dir')) {
            error('Usage: ferrox-tools query visual.stop --session-dir <path> | --project-dir <path>');
            return;
        }
        emit({ status: 'not_running' }, raw);
        return;
    }
    const res = node_child_process_1.default.spawnSync('bash', [node_path_1.default.join(VISUAL_SCRIPTS_DIR, 'stop-server.sh'), sessionDir], { encoding: 'utf8', shell: false });
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
function routeVisualCommand({ args, cwd, raw, error }) {
    routeCjsCommandFamily({
        args,
        subcommands: command_aliases_cjs_1.VISUAL_SUBCOMMANDS,
        unsupported: {},
        error,
        unknownMessage: (_s, available) => `Unknown visual subcommand. Available: ${available.join(', ')}`,
        handlers: {
            'start': () => handleStart(args, cwd, raw, error),
            'stop': () => handleStop(args, cwd, raw, error),
            'status': () => handleStatus(args, cwd, raw, error),
        },
    });
}
module.exports = { routeVisualCommand };
