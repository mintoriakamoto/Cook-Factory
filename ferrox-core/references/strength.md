# Strength Layer

The Strength Layer is what makes **"landed" mean genuinely strong** in Ferrox Factory. Its
single promise: **a candidate merge only lands when the required evidence is present — an
independent severity judgment, proven-failing (red-green) receipts, mutation-checked
coverage, security never buried in a backlog, and a backlog that cannot grow to reach
"landed" — and that verdict is enforced un-bypassably at the tool layer.**

This reference is the **one place** the strength model is described (mirroring
[coordination.md](coordination.md) for the parallel-safety layer and [halting.md](halting.md)
for the anti-loop layer). The eight verbs below are the enforceable cores; the
`strength.*` config block is their schema; `strength.merge-gate` is the fail-closed
aggregator; and `ferrox-merge-gate-guard.js` is the PreToolUse hook that makes the aggregate
verdict un-skippable. Every other reference and workflow that needs a strength decision must
**consult the verbs named here** — it must never restate the judge, receipt, mutation,
severity, burndown, or merge-gate logic in prose. The verb is the single source of truth.

---

## Config block

The strength knobs live under a single `strength.*` block in `.planning/config.json`. All keys
have built-in fallbacks (sourced from the config-defaults manifest and propagated through all
three `config-loader` branches — the Phase-3 config-propagation trap), so an absent or partial
block degrades to sane defaults rather than crashing.

```jsonc
{
  "strength": {
    "medium_cluster_threshold": 3,               // ≥N related MEDIUMs on one surface → synthesize HIGH
    "security_age_limit_days": 7,                 // a security/correctness backlog item older than this → burndown blocked
    "receipt_store": ".planning/strength/receipts.json",         // where red-green receipts persist
    "coverage_store": ".planning/strength/coverage-baseline.json", // the before-coverage baseline (fail-CLOSED: absent → block)
    "requirements_path": ".planning/REQUIREMENTS.md",            // the real coverage source (FF-B11)
    "findings_store": ".planning/strength/findings.json",        // open security/severity findings (un-forgeable store)
    "backlog_path": ".planning/BACKLOG.md",                      // open SEC/CORRECTNESS rows fed to security + burndown
    "security_categories": ["security", "auth", "crypto", "injection", "secrets", "deserialization"]
  }
}
```

### Built-in fallbacks (used when a key is absent)

| Key | Default | Meaning |
|-----|---------|---------|
| `strength.medium_cluster_threshold` | `3` | A cluster of ≥N related MEDIUMs on one surface is synthesized into a `HIGH`. |
| `strength.security_age_limit_days` | `7` | A security/correctness backlog item aged past this limit blocks the burndown. |
| `strength.receipt_store` | `.planning/strength/receipts.json` | The red-green receipt store `strength.receipt` writes and `strength.verify-receipt` reads. |
| `strength.coverage_store` | `.planning/strength/coverage-baseline.json` | The before-coverage baseline fed to `coverage.delta`. **Fail-CLOSED (Fix 3): an absent/unreadable baseline blocks the merge gate** (`coverage-baseline-missing`) — seed it at increment start. |
| `strength.requirements_path` | `.planning/REQUIREMENTS.md` | The REAL coverage source (FF-B11) `strength.coverage-source` counts. |
| `strength.findings_store` | `.planning/strength/findings.json` | The on-disk open-findings store (`{ "open": [ {category, severity}, … ] }`) the merge gate reads for open security — an increment cannot omit a real open finding from its manifest (Fix 2). |
| `strength.backlog_path` | `.planning/BACKLOG.md` | The merge gate parses the `## Open` table for `SEC`/`CORRECTNESS`-severity rows — open security rows raise the security count, and aged rows feed the burndown floor (Fix 2). |
| `strength.security_categories` | `security, auth, crypto, injection, secrets, deserialization` | Case-insensitive categories that `strength.severity-route` never auto-backlogs. |

Config is resolved once at the router boundary (`loadConfig(cwd).strength`) and the EXPLICIT
values are forwarded to the pure cores — never restated as a hard-coded number in prose.

---

## The eight strength verbs

Each verb is a real, tested CLI core, dispatchable via `ferrox-tools query strength.<verb>`
(the `ferrox_run` shell helper wraps the same shim — `ferrox_run query strength.<verb>`). They
are pure decision functions: they take explicit inputs and return a terminal `decision`, with
no hidden clock or global mutation inside the check.

```bash
# Canonical dispatch form — every strength decision is one of these:
ferrox-tools query strength.judge-check --author <id> --judge <id>
ferrox_run   query strength.merge-gate  --increment <id> --requirements <a,b> ...
```

### `strength.judge-check` — independent severity judgment (STRONG-01)

```bash
ferrox-tools query strength.judge-check --author <id> --judge <id>
```

Validates that a severity/risk record carries an INDEPENDENT judge identity **≠** the author.
An author who assigns their own severity is `rejected-self-judged`; an independent judge is
`accepted`. Matching is case-insensitive (the Phase-4 case-sensitivity trap).

```jsonc
{ "decision": "accepted" }              // judge ≠ author — independent judgment
{ "decision": "rejected-self-judged" }  // author graded their own work — rejected
```

### `strength.severity-route` — security never buried (STRONG-04)

```bash
ferrox-tools query strength.severity-route --findings <json>
```

Routes findings by category/severity against `strength.security_categories` and
`strength.medium_cluster_threshold` (both case-insensitive). A security-category finding is
`block` at ANY severity — it is NEVER auto-backlogged; a cluster of ≥N related MEDIUMs on one
surface is synthesized into a `HIGH`; everything else is `route-backlog`.

```jsonc
{ "decision": "block", "reason": "security-never-backlog" }                       // security → block at any severity
{ "decision": "synthesize-high", "synthesized": "HIGH", "surface": "...", "medium_count": 3 } // MEDIUM cluster → HIGH
{ "decision": "route-backlog" }                                                   // ordinary finding → backlog
```

### `strength.receipt` — record a red-green receipt (STRONG-02)

```bash
ferrox-tools query strength.receipt \
  --requirement <id> --test <path> --exit-code <n> --log-digest <hash> --commit <sha>
```

Records a red-green receipt `{requirement, test, failing_run:{exit_code, log_digest}, commit}`
into the `strength.receipt_store`. The receipt captures the requirement's test **observed
failing** (the RED evidence) before it went green — the proof the test can actually fail.

### `strength.verify-receipt` — validate a receipt (STRONG-02)

```bash
ferrox-tools query strength.verify-receipt --requirement <id>
```

Reads the receipt store and returns `missing` (no receipt), `never-red` (a receipt with no
observed-failing run — fake coverage), `fabricated-commit` (an otherwise-valid receipt whose
`commit` does not resolve in the repo — Fix 5), or `valid`. The merge gate rejects any
requirement whose test was never observed failing or whose commit is fabricated. The
commit-existence check runs only when an optional `repoDir` is a git repo (the router passes the
project cwd); in a hermetic non-repo context it is skipped.

```jsonc
{ "decision": "missing", "requirement": "REQ-1" }            // no receipt at all
{ "decision": "never-red", "requirement": "REQ-1" }          // test never observed failing — not proven
{ "decision": "fabricated-commit", "requirement": "REQ-1" }  // commit does not exist in the repo (Fix 5)
{ "decision": "valid", "requirement": "REQ-1" }              // a genuine red-green receipt
```

### `strength.mutation-check` — real vs fake coverage (STRONG-03)

```bash
ferrox-tools query strength.mutation-check --test <path> --flipped <true|false>
```

Given whether a requirement's mapped test flipped to red when its target was mutated, returns
`killed` (the test caught the mutant — REAL coverage) or `survived` (the mutant lived — FAKE
coverage → rejected). This is a **bounded** harness: it turns one observed mutation flip into a
verdict; it is not a full mutation-testing framework (see Mechanism vs Protocol).

```jsonc
{ "decision": "killed" }    // mapped test flipped red under mutation — real coverage
{ "decision": "survived" }  // mutant survived — fake coverage, rejected
```

### `strength.burndown-check` — a backlog that can't grow to "landed" (STRONG-05)

```bash
ferrox-tools query strength.burndown-check \
  --opened <n> --resolved <n> --items <json>
```

Returns `blocked` if the net backlog grew for this increment OR a security/correctness item
aged past `strength.security_age_limit_days`; else `ok`. Missing inputs fail closed to
`blocked`.

```jsonc
{ "decision": "ok" }
{ "decision": "blocked", "reason": "net-backlog-grew" }   // backlog grew — cannot land
{ "decision": "blocked", "reason": "aged-item" }          // a security/correctness item aged past the limit
{ "decision": "blocked", "reason": "missing-inputs" }     // fail closed on absent counts
```

### `strength.coverage-source` — the REAL coverage source (FF-B11)

```bash
ferrox-tools query strength.coverage-source
```

A pure reader that counts requirement completion from the real `strength.requirements_path`
(REQUIREMENTS.md traceability checkboxes) rather than trusting caller-supplied numbers. Returns
`{ covered, total }`, feeding `after.covered` into `coverage.delta` so a no-op merge (zero
coverage advance) is rejected as `not-landed`. A missing/unreadable file returns
`{ covered: 0, total: 0 }` (fail closed — no provable advance).

```jsonc
{ "covered": 5, "total": 12 }   // real requirement-completion count from REQUIREMENTS.md
```

### `strength.coverage-baseline --snapshot` — seed the before-baseline (FF-B10 Fix 3)

```bash
ferrox-tools query strength.coverage-baseline --snapshot
```

An increment-start seeding helper (not one of the eight enforcement verbs). It writes the
CURRENT covered-requirement count (from `strength.requirements_path`) into
`strength.coverage_store` as `{ covered }`, so the merge gate's `before` count is the coverage
at increment start. Because the merge gate now reads the baseline **fail-CLOSED** (an absent or
unreadable baseline blocks with `coverage-baseline-missing`), the increment MUST snapshot the
baseline at start — a no-op merge (no coverage advance over the snapshot) is then rejected, and
a merge run with no baseline at all can no longer land against a phantom `0`.

```jsonc
{ "decision": "snapshotted", "covered": 5 }
```

### `strength.merge-gate` — the fail-closed aggregate verdict (FF-B10)

```bash
ferrox-tools query strength.merge-gate \
  --increment <id> --requirements <a,b> --declared <set> --actual <set> --files <set> \
  --opened <n> --resolved <n> --mutation-test <path> --mutation-flipped <bool> \
  [--hot-seam-serialized <bool> --findings <json> --items <json> --migration-number <n>]
```

The aggregator. It gathers the required evidence for a candidate merge — receipts all `valid`
+ coverage `landed` (real source, strictly positive delta) + ownership `ok` + hot seam
`serialized` + burndown `ok` + no open security + no open CRITICAL/HIGH — and returns `pass`
ONLY when every field is affirmative, else `block` with the FULL list of failing `reasons`. It
**fails closed**: a null/undefined field, an absent store, or an input verb that throws is
captured as `input-verb-error` and blocks — an errored input verb is NEVER coerced to
affirmative.

**hot_seam evidence (Fix 1 — the seam-serialization protocol, not "touches no seam").** The
`hot_seam` field asserts that the **global serial lock WAS honored for this increment**, NOT
that the increment touched no seam. An increment whose `--files` touch no hot seam has nothing
to serialize → `serialized`. An increment that DOES touch a seam (a migration, a lockfile)
clears the gate only when the orchestrator asserts serialization with `--hot-seam-serialized
true` → `serialized`; touching a seam WITHOUT that assertion is `not-serialized` → block. This
closes the earlier deadlock where an honest migration increment could never pass (its only
"escape" was to lie by omitting the seam files from `--files`). Omitting the flag can only make
the gate stricter, never laxer.

```jsonc
{ "decision": "pass", "reasons": [] }
{ "decision": "block", "reasons": ["receipts-not-valid", "coverage-not-landed", "input-verb-error"] }
```

The full `reasons` vocabulary the core emits: `receipts-not-valid`, `coverage-not-landed`,
`mutation-survived`, `ownership-not-ok`, `hot-seam-not-serialized`, `burndown-not-ok`,
`security-open`, `critical-high-open`, `input-verb-error`.

---

## The un-bypassable enforcer (FF-B10)

`strength.merge-gate` is only trustworthy if a caller cannot simply forget to call it. The
enforcer that closes that gap is **`hooks/ferrox-merge-gate-guard.js`** — a **PreToolUse Bash
hook** registered in `hooks/hooks.json` under `PreToolUse` with `"matcher": "Bash"`. It
intercepts merge / ship / release tool operations and **fails closed**:

- It is a benign pass-through (`exit 0`) for every tool call EXCEPT a KNOWN merge/ship/release op.
- On a detected merge op — `git merge`, `gh pr merge`, `git pull`, `git rebase`, a
  protected-branch/release-tag push (including a bare/`HEAD` push while on a protected branch),
  or a GitHub MCP `merge_pull_request` / `push_files` / `create_or_update_file` (protected
  branch) call — it resolves the verb at `__dirname/../ferrox-core/bin/ferrox-tools.cjs` (no
  PATH/env override — an override would be a bypass), reads the on-disk evidence manifest
  (`.planning/strength/merge-gate-request.json`), and shells out to
  `ferrox-tools query strength.merge-gate … --raw`.
- `decision === 'pass'` → `exit 0` (ALLOW). **Any** other outcome — non-`pass` decision,
  missing verb, missing/malformed manifest, non-zero status, unparseable stdout, or ANY thrown
  error — → **`exit 2` (BLOCK)**. This is the deliberate inversion of the worktree guard's
  "error → silent pass": for a merge op, an error is a BLOCK, never a pass-through.
- **Honest limit:** this is a client-side command/tool matcher — it covers the known vectors and
  fails closed, but it is not cryptographically un-bypassable (arbitrary scripts / novel tools
  can evade a matcher). The un-bypassable layer is server-side branch protection / a pre-receive
  hook — publish-time item **FF-B17**.

Because the hook blocks the merge **tool call itself** at the tool boundary, a forgetful or
rogue caller cannot skip the strength gate — "consulted" (Phases 3–4) finally becomes
"enforced." The hook is PreToolUse-only, NOT a SessionStart inject, so `check-single-mandate`
(DISC-02) stays green.

---

## Ship / merge wiring

The ship/merge protocol **CONSULTS** `strength.merge-gate` for the aggregate landed verdict,
and — unlike the Phase-3 halting verbs and Phase-4 coordination verbs — this one is also
**ENFORCED** un-bypassably by `ferrox-merge-gate-guard.js`:

- **[gates.md](gates.md)** — the ship/merge row cites `strength.merge-gate` as the aggregate
  landed verdict and records that FF-B10 is now closed by the PreToolUse hook.
- **[ship.md](../workflows/ship.md)** — the ship gate consults `strength.merge-gate` before
  creating/merging the PR and notes the hook independently enforces it at the tool layer.

---

## Mechanism vs Protocol (honest)

Be honest about what is enforced code and what is documented orchestration. This split is
deliberate: do not over-claim un-bypassability beyond the tool layer, and do not imply the
verb spawns an agent it does not spawn.

### Mechanism — enforced code, backed by red-green tests

These are the enforceable cores. They are real CLI verbs with tests; they take explicit inputs
and return a terminal decision:

- **Independent judgment** — `strength.judge-check`: `accepted` / `rejected-self-judged`.
- **Severity routing** — `strength.severity-route`: security → `block`, MEDIUM cluster →
  `synthesize-high`, else `route-backlog`.
- **Red-green receipts** — `strength.receipt` / `strength.verify-receipt`: record + validate
  (`missing` / `never-red` / `valid`).
- **Mutation coverage** — `strength.mutation-check`: `killed` / `survived`.
- **Backlog burndown** — `strength.burndown-check`: `ok` / `blocked`.
- **Real coverage source** — `strength.coverage-source`: `{covered, total}` from REQUIREMENTS.md.
- **The aggregate verdict** — `strength.merge-gate`: `pass` / `block(reasons[])`, fail-closed.

### The genuinely un-bypassable boundary — and its exact scope

**The merge-gate verb + the `ferrox-merge-gate-guard.js` PreToolUse hook are genuinely
un-bypassable at the tool layer for the KNOWN merge vectors, and fail closed.** Claude Code's PreToolUse hook can
block the tool call itself, so a merge/ship/release op with missing or non-`pass` evidence is
refused (`exit 2`) before it runs — the caller cannot skip it by simply not invoking the verb.
The hook covers `git merge` / `gh pr merge` / `git pull` / `git rebase` / protected-branch &
release-tag pushes (including a bare/`HEAD` push while on a protected branch) AND the GitHub MCP
`merge_pull_request` / `push_files` / `create_or_update_file` (protected-branch) tools. This is
the real, tested FF-B10 enforcement (both-directions test: block on missing evidence, allow on a
seeded pass).

**Be honest: a client-side command hook is NOT cryptographically un-bypassable.** It covers all
merge vectors we KNOW about and fails closed, but an arbitrary shell script, an aliased binary,
or a novel tool the matcher does not recognize can still evade a command matcher. The claim is
precisely: *within a Ferrox-installed Claude Code project, the registered PreToolUse hook blocks
every known merge tool call and fails closed.* It is NOT a claim that merging is impossible by
some out-of-band means (a different machine, a hook-less checkout, a direct force-push on a
server). **The cryptographically-un-bypassable layer is SERVER-SIDE branch protection /
pre-receive hooks — a publish-time item tracked as FF-B17.** Do not read the tool-layer
enforcement as broader than the tool calls it gates.

### Protocol — documented orchestration the workflows follow

- **Independent judge (STRONG-01) is ORCHESTRATION PROTOCOL.** The *judge being a separate
  frontier agent* is a routine the workflow spawns; the verb does **NOT** spawn the judge. The
  verb `strength.judge-check` only ENFORCES that the record shows **judge ≠ author**. Do not
  claim the verb spawns the independent agent — it enforces the identity constraint on the
  record, and the workflow is responsible for actually obtaining an independent judgment.
- **The mutation harness is a BOUNDED real demo, not a full framework.**
  `strength.mutation-check` turns one observed survived/killed mutation into a verdict, and the
  phase ships one REAL survived-mutant-caught demonstration. It is deliberately scoped — it is
  not a general mutation-testing framework that instruments an entire codebase.
- **The ship/merge consult is protocol on TOP of the enforced hook.** gates.md and ship.md
  consult `strength.merge-gate` as documented routine; the un-bypassable teeth are the
  PreToolUse hook, not the prose consult.

**The verb is the single source of truth for every strength decision.** Workflows and
references must consult the verb; they must never restate the judge, receipt, mutation,
severity, burndown, or merge-gate logic as a hard-coded rule in prose.
