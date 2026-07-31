'use strict';

/**
 * Error that carries a process exit code. CLI logic throws this instead of
 * calling process.exit() (banned by n/no-process-exit); runMain() translates it
 * into process.exitCode at the entrypoint.
 *
 * @param {number} code  exit code (default 1)
 * @param {string} [message]  optional human message; when set and code != 0 it is
 *   written to stderr by runMain before the process exits.
 */
class ExitError extends Error {
  constructor(code = 1, message) {
    super(message === undefined ? `process exit ${code}` : message);
    this.name = 'ExitError';
    this.code = code;
    // Whether runMain should print this.message to stderr (only when a real
    // message was provided, not the synthetic default).
    this.hasUserMessage = message !== undefined;
  }
}

/**
 * Run a CLI main function and translate its outcome into process.exitCode
 * (never process.exit(), so n/no-process-exit stays satisfied). Supports sync or
 * async main.
 *   - main returns a number  -> process.exitCode = that number
 *   - main throws/rejects ExitError -> process.exitCode = err.code, and if
 *       err.hasUserMessage && err.code !== 0, err.message is written to stderr
 *   - main throws/rejects anything else -> the stack is written to stderr and
 *       process.exitCode = 1
 * Letting the event loop drain (vs process.exit) means buffered stdout/stderr is
 * flushed and process.on('exit') cleanup handlers still fire.
 *
 * @param {() => (number|void|Promise<number|void>)} main
 */
function runMain(main) {
  Promise.resolve()
    .then(() => main())
    .then((code) => {
      if (typeof code === 'number') process.exitCode = code;
    })
    .catch((err) => {
      if (err instanceof ExitError) {
        if (err.hasUserMessage && err.code !== 0) {
          process.stderr.write(`${err.message}\n`);
        }
        process.exitCode = err.code;
        return;
      }
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    });
}

/**
 * The recovery footer EVERY refusal on the fleet path ends with.
 *
 * This is `NOTHING_HAPPENED` (scripts/fleet-dispatch.cjs) one level up. That
 * constant exists because the promise "nothing was minted" used to be carried by
 * exactly 1 refusal, leaving readers of the others to infer it. The recovery path
 * was worse: it was carried by 0 refusals. A count over 13,423 lines of shipped
 * scripts found 0 mentions of ferrox-health, ferrox-resume-work, ferrox-undo,
 * ferrox-pause-work, ferrox-config, ferrox-help, ferrox-forensics,
 * ferrox-progress or ferrox-next. Not one refusal named a way out, so a beginner
 * who hit a legitimate refusal learned what was wrong and nothing about what to
 * do, which is the difference between a gate and a wall.
 *
 * Every command named here is verified to exist as a shipped command. Naming a
 * command that does not exist would reproduce the defect this fixes: a refusal
 * that sends the reader somewhere absent.
 */
const WAY_OUT = 'Not sure what to do next: /ferrox-health checks this project, '
  + '/ferrox-resume-work picks up where you left off, /ferrox-undo reverses the last step.';

/**
 * Append the recovery footer to a refusal message, at most once.
 *
 * Idempotent BY CONSTRUCTION. Refusals on this path are wrapped and re-wrapped
 * (`refuse` already appends its own promise, and callers rethrow), so a helper
 * that appended unconditionally would stack the same 3 commands 2 or 3 deep on
 * exactly the messages a struggling reader is already trying to parse.
 */
function withWayOut(message) {
  const text = typeof message === 'string' ? message : String(message);
  if (text.includes(WAY_OUT)) return text;
  return `${text}\n${WAY_OUT}`;
}

module.exports = { ExitError, runMain, WAY_OUT, withWayOut };
