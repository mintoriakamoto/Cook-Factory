'use strict';

/**
 * EVERY REFUSAL ON THE FLEET PATH CARRIES A WAY OUT.
 *
 * `scripts/fleet-dispatch.cjs` already proved this shape once. `NOTHING_HAPPENED`
 * is 1 constant appended by `refuse()` to every message on that path, and its
 * comment records why: the promise "nothing was minted" used to be carried by
 * exactly 1 refusal, so readers of the others were told what went wrong and left
 * to infer whether anything had already happened.
 *
 * The recovery path was the same bug one level worse. A count across 13,423 lines
 * of shipped `scripts/*.cjs` found mentions of `ferrox-undo`, `ferrox-resume-work`,
 * `ferrox-pause-work`, `ferrox-health`, `ferrox-config`, `ferrox-help`,
 * `ferrox-forensics`, `ferrox-progress` and `ferrox-next` totalling 0 for EVERY
 * ONE. Not one refusal in the enforcement layer named a way out, so a beginner who
 * hit a legitimate refusal learned what was wrong and nothing about what to do.
 * That is the difference between a gate and a wall.
 *
 * ─── THE ARM THAT MATTERS ────────────────────────────────────────────────────
 *
 * `THE FOOTER REACHES A REAL REFUSAL FROM A CHILD PROCESS` spawns the shipped
 * script the way a person runs it and reads its stderr. A test that imports the
 * module and calls `refuse()` directly proves only that a function concatenates
 * strings; it cannot witness whether the message a user actually receives carries
 * the footer, because that path runs through `runMain`, `ExitError` and the
 * process boundary.
 *
 * ─── AND THE ONE THAT STOPS THIS BEING DECORATION ────────────────────────────
 *
 * `EVERY COMMAND NAMED IN THE FOOTER SHIPS` resolves each command in the footer
 * against the shipped command set. The defect class this session proved 5 times is
 * a correct artifact behind a path that does not resolve, and this very fix
 * replaced 2 refusals that pointed at `.planning/BACKLOG.md` and
 * `docs/reference/fleet-operations.md`, neither of which exists in a customer
 * install. A footer naming an absent command would reproduce exactly that.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { WAY_OUT, withWayOut } = require(path.join(ROOT, 'scripts', 'lib', 'cli-exit.cjs'));

/** The commands the footer names, extracted from the constant rather than restated. */
function commandsNamedInFooter() {
  return [...WAY_OUT.matchAll(/\/ferrox-([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
}

test('the footer NAMES COMMANDS: a non zero count, before any property over them', () => {
  const named = commandsNamedInFooter();
  // "Every command in the footer exists" is vacuously true of a footer that names
  // none, and a footer that names none is precisely the bug being fixed.
  assert.ok(named.length >= 3, `the footer must name 3+ recovery commands, named ${named.length}`);
  assert.ok(named.includes('health'), `expected /ferrox-health, got: ${named.join(', ')}`);
  assert.ok(named.includes('resume-work'), `expected /ferrox-resume-work, got: ${named.join(', ')}`);
  assert.ok(named.includes('undo'), `expected /ferrox-undo, got: ${named.join(', ')}`);
});

test('EVERY COMMAND NAMED IN THE FOOTER SHIPS', () => {
  const cmdDir = path.join(ROOT, 'commands', 'ferrox');
  const shipped = new Set(
    fs.readdirSync(cmdDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)),
  );
  assert.ok(shipped.size > 40, `the shipped set must be non empty first, got ${shipped.size}`);

  const named = commandsNamedInFooter();
  assert.ok(named.length >= 3, 'denominator first');
  const absent = named.filter((c) => !shipped.has(c));
  assert.deepStrictEqual(
    absent, [],
    `the footer sends the reader to commands that do not ship: ${absent.join(', ')}`,
  );
});

test('withWayOut is IDEMPOTENT: the same 3 commands never stack', () => {
  const once = withWayOut('something went wrong');
  const twice = withWayOut(once);
  const thrice = withWayOut(twice);
  assert.strictEqual(twice, once, 'a second application must not append again');
  assert.strictEqual(thrice, once, 'a third application must not append again');
  // Counted, not eyeballed: refusals on this path are wrapped and rethrown, so a
  // non idempotent helper would stack the footer on exactly the messages a
  // struggling reader is already trying to parse.
  const occurrences = thrice.split(WAY_OUT).length - 1;
  assert.strictEqual(occurrences, 1, `the footer appears ${occurrences} times, expected 1`);
});

test('withWayOut PRESERVES the original message', () => {
  const original = 'REFUSING to dispatch (E_BAD_BOUND): capacity must be a positive whole number';
  const out = withWayOut(original);
  assert.ok(out.startsWith(original), 'the diagnosis must survive the footer');
  assert.ok(out.length > original.length, 'the footer must actually be appended');
});

test('THE FOOTER REACHES A REAL REFUSAL FROM A CHILD PROCESS', () => {
  // fleet-dispatch with no manifest is a genuine refusal on the shipped path.
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'fleet-dispatch.cjs')], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, FERROX_PROJECT: ROOT },
  });
  const combined = `${res.stdout || ''}${res.stderr || ''}`;
  // The refusal itself must have happened, or the footer assertion is vacuous.
  assert.notStrictEqual(res.status, 0, `expected a refusal exit code, got ${res.status}`);
  assert.ok(combined.length > 0, 'the refusal produced no output at all');
  assert.ok(
    combined.includes(WAY_OUT),
    `a real refusal did not carry the way out.\n--- observed ---\n${combined}`,
  );
});

test('THE CHILD PROCESS ARM CAN FAIL: an unrelated success carries no footer', () => {
  // The required failing arm for the arm above. If every invocation of every script
  // happened to contain the footer text, the assertion would pass for a build that
  // printed it unconditionally, including on success, which would be its own defect.
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'fleet-ask.cjs'), '--contract'], {
    cwd: ROOT,
    encoding: 'utf-8',
  });
  assert.strictEqual(res.status, 0, `--contract should succeed, got ${res.status}`);
  assert.ok(res.stdout.length > 0, 'the contract printed nothing');
  assert.ok(
    !res.stdout.includes(WAY_OUT),
    'a SUCCESSFUL run must not carry a refusal footer',
  );
});

/* ------------------------------------------------------------------------ *
 * The anti loop menu: 4 bare tokens became 4 explained choices
 * ------------------------------------------------------------------------ */

const ask = require(path.join(ROOT, 'scripts', 'fleet-ask.cjs'));

test('the escalation refusal EXPLAINS the 4 legal moves rather than listing ids', () => {
  const out = ask.buildEscalationMenu({
    ask: { node: 'n1', cause: 'rounds-exceeded', severity: 'high', reason: 'r' },
    requestedMove: 'try again',
  });
  assert.strictEqual(out.ok, false, 'try again must be refused');
  const msg = out.message;

  // The 4 move ids were always printed. The descriptions that make them mean
  // something were declared 20 lines above in the same file and thrown away at
  // exactly the moment a person needed them.
  for (const id of ['descope', 'change-approach', 'documented-fence', 'park']) {
    assert.ok(msg.includes(id), `the refusal must name the move ${id}`);
  }
  assert.ok(
    msg.includes('cut what the node must deliver'),
    'the refusal must carry the DESCRIPTION of descope, not only its id',
  );
  assert.ok(
    msg.includes('free the surface it is holding'),
    'the refusal must carry the DESCRIPTION of park, not only its id',
  );
});

test('the refusal says WHY "try again" is not on the menu', () => {
  const out = ask.buildEscalationMenu({
    ask: { node: 'n1', cause: 'rounds-exceeded', severity: 'high', reason: 'r' },
    requestedMove: 'retry',
  });
  assert.strictEqual(out.ok, false);
  // An option removed WITHOUT its reason reads as an arbitrary restriction, which
  // invites working around it. The reason existed only as a source comment.
  assert.ok(
    /unbounded loop/i.test(out.message),
    `the refusal must state why repeating is banned.\n--- observed ---\n${out.message}`,
  );
});

test('the escalation refusal ALSO carries the way out', () => {
  const out = ask.buildEscalationMenu({
    ask: { node: 'n1', cause: 'rounds-exceeded', severity: 'high', reason: 'r' },
    requestedMove: 'nonsense-move',
  });
  assert.strictEqual(out.ok, false);
  assert.ok(out.message.includes(WAY_OUT), 'an illegal move refusal must carry the way out');
});

test('THE FOOTER IS CARRIED BY EVERY NAMED REFUSAL PATH, counted', () => {
  // A counter over the paths, not a flag per path. The bug being fixed is a promise
  // carried by SOME refusals, and "the footer is present" is satisfiable by 1 of 4.
  // So the paths are enumerated and the total is asserted, which fails when a path
  // is added without the footer as well as when one loses it.
  const crew = require(path.join(ROOT, 'scripts', 'fleet-crew.cjs'));
  const controlplane = require(path.join(ROOT, 'scripts', 'fleet-controlplane.cjs'));

  const paths = [
    {
      name: 'fleet-ask illegal move',
      message: ask.buildEscalationMenu({
        ask: { node: 'n', cause: 'rounds-exceeded', severity: 'high', reason: 'r' },
        requestedMove: 'nonsense',
      }).message,
    },
    {
      name: 'fleet-crew empty crew',
      message: crew.projectAssignments({ nodes: [{ id: 'a', wave: 0 }], crew: [] }).message,
    },
    {
      name: 'fleet-controlplane hook consent',
      message: controlplane.hookAckRefusalLine({ repoRoot: '/tmp/x', hooksDir: '/tmp/x/.git/hooks' }),
    },
  ];

  // Denominator first. An empty list makes "every path carries it" vacuous, and a
  // rename that broke one of these requires would produce exactly that.
  assert.strictEqual(paths.length, 3, 'all 3 enumerated refusal paths must be reachable');
  for (const p of paths) {
    assert.ok(
      typeof p.message === 'string' && p.message.length > 0,
      `${p.name}: produced no message, so the assertion below would be vacuous`,
    );
  }

  const carrying = paths.filter((p) => p.message.includes(WAY_OUT));
  assert.strictEqual(
    carrying.length, paths.length,
    `only ${carrying.length} of ${paths.length} refusal paths carry the way out. Missing: `
      + paths.filter((p) => !p.message.includes(WAY_OUT)).map((p) => p.name).join(', '),
  );
});

test('fleet-loop verdicts DELIBERATELY do not carry it', () => {
  // The mirror assertion, and it is a real design constraint rather than an
  // omission. fleet-loop's refuse() returns a verdict whose `refused_because` is
  // folded into run records and compared across arms, so a human recovery footer in
  // that field would enter every measurement taken over it.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'fleet-loop.cjs'), 'utf-8');
  assert.ok(src.length > 1000, 'must have read the driver');
  // Strip comments before searching, so the recorded REASON for the exclusion does
  // not read as an instance of the thing being excluded. `[^\r\n]` rather than
  // `[^\n]`: Windows git-autocrlf yields \r\n, and a bare \n class would leave the
  // carriage return behind (local/no-crlf-fragile-split).
  const withoutComments = src.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !/withWayOut/.test(withoutComments),
    'fleet-loop must not append the footer to structured verdicts',
  );
  // And the reason must be recorded where the next reader will look, or it gets
  // "fixed" by someone adding it for consistency.
  assert.ok(
    /No `withWayOut` here on purpose/.test(src),
    'the exclusion must carry its reason, or it reads as an oversight',
  );
});

test('NO REFUSAL POINTS AT A FILE THAT DOES NOT SHIP', () => {
  // 2 control plane refusals sent the reader to `.planning/BACKLOG.md` and
  // `docs/reference/fleet-operations.md`. Both exist in THIS repository and neither
  // ships, which is why every gate passed: every gate ran here.
  const scriptsDir = path.join(ROOT, 'scripts');
  const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.cjs'));
  assert.ok(files.length > 20, `must scan a real script set, found ${files.length}`);

  // Paths that exist in the repository and are stripped from the published package.
  const NOT_SHIPPED = ['.planning/BACKLOG.md', 'docs/reference/fleet-operations.md'];
  const offenders = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(scriptsDir, f), 'utf-8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      // Only user-facing message text matters; a path inside a require or a comment
      // marker is not something a refusal hands to a reader.
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
      for (const p of NOT_SHIPPED) {
        if (line.includes(p)) offenders.push(`${f}:${i + 1} -> ${p}`);
      }
    });
  }
  assert.deepStrictEqual(
    offenders, [],
    `these refusals send a customer to a path absent from their install:\n${offenders.join('\n')}`,
  );
});
