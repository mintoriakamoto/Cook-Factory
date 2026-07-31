# ratchet-maintain — LANDING FENCED (post round-5 audit, 2026-07-09)

Branch `feat/ratchet-maintain-sandbox`. Boards (issues/prs) + PR gate. maintain selftest **36/36**.
Hardened across 4 council rounds + a round-5 3-lens adversarial audit (sandbox-escape / fail-open /
robustness). **Shipping posture: boards + secret-scan LIVE; the PR gate's untrusted-suite execution is
FENCED OFF by default** (`_untrusted_exec_allowed`, opt-in `RATCHET_GATE_ALLOW_UNTRUSTED=1` for a
trusted author's PR only). Rationale below.

## Round-5 audit — folded THIS pass (each locked by a selftest)
- **CRITICAL (fail-open) — separator bypass:** the diff scan used `str.splitlines()`, which breaks on
  `\v \f \x1c U+0085 U+2028 U+2029` (more than git's `\n`), so a token after such a byte lost its `+`
  and read as clean. FIXED: stream + regex-scan a sliding window over the whole combined diff (no
  line-prefix filter). Regression test: "secret hidden after an in-line control byte".
- **HIGH (robustness) — scan OOM:** `--text` expands binary blobs to full content and the whole diff
  was captured into RAM; a huge/hostile added file OOM-killed the unattended gate. FIXED: stream in 1MB
  chunks, 64MB fail-closed cap.
- **MED — false green on missing suite:** absent/mistyped `suite_cmd` recorded `suite PASS (skipped)`.
  FIXED: no suite = fail-closed "cannot certify".
- **MED — swallowed restore:** `guarded_suite`'s `restore_ok` was discarded. FIXED: `restore_ok==False`
  is now a hard `containment-restore` FAIL.
- **LOW — boards timeout:** the `prs` statusCheckRollup query could exceed the kernel's 45s default.
  FIXED: 180s.
- Overclaiming docstrings ("no secret to exfiltrate") corrected to state the real boundary.

## WHY the gate stays FENCED (the architectural residual the fence exists for)
`guarded_suite` contains repo WRITES, but the suite still runs with the operator's real **$HOME + open
network**. A malicious PR test file can `curl` out `~/.config/wl/*.env` (Flux keys), `~/.ssh`, gh token,
or write `~/.gitconfig`/shell-rc for host RCE. That needs an **OS-level sandbox (scrubbed HOME + egress
control)**, not another in-process patch. Until that ships, executing untrusted PR code is fenced off.

## What is SOLID (landable)
- Boards: read-only, gh-backed, no state mutation.
- Gate suite runs in the governed sandbox (`guarded_suite`): allowlisted env (no GH_TOKEN/API keys),
  own process group, **non-blocking** wall-clock cap (shared `_supervise`, used by run_card too),
  byte-for-byte worktree restore, .git hook/config tamper + symlink/realpath-escape rejection.
- Secret scan: SHA-pinned range, per-commit (`git log -p`), catches add-then-remove, **evil-merge
  resolutions (`--cc`)**, commit **messages**, and binaries (lenient decode). Fail-closed on git error.
- Ref-guarded `--ref`, leak-free `ratchet-pr-N` branch lifecycle, concurrency-safe worktree names.

## The ONE architectural residual — ref/metadata containment in a SHARED gitdir
The gate suite runs in a linked worktree that shares the canonical common gitdir. Reverting a suite's
ref/hook/config tamper AFTER the fact is whack-a-mole (council proved it repeatedly):
- revert `update-ref` is unverified + defeatable by a stale `refs/heads/main.lock` (mainline stays
  poisoned, restore_ok still True; lock persists = mainline update-ref DoS);
- `run_card` (agent path) has NO ref containment at all — same shared gitdir, pre-existing;
- created refs persist; symbolic refs get downgraded to direct;
- a non-UTF-8 `-z` path crashes the audit BEFORE restore → injected hook survives (CRITICAL, RCE
  bypass — also latent in shipped ratchet-exec via K.git strict decode);
- `_supervise` buffers all child stdout unbounded → OOM DoS.

### CONVERGENT FIX (next session — do this instead of more patches)
1. **Run the gate suite in a throwaway local clone**, not a linked worktree — physical ref/hook/
   config isolation from canonical. Kills the ref-tamper, hook-tamper, config-tamper, and
   crash-before-restore classes for the gate in one move.
2. **Cap `_supervise` output** (ring-buffer to N bytes; drop the middle) — closes the OOM DoS for
   both run_card and the gate.
3. **Lenient decode / bytes in the containment audit** (`_status_z`/`_changed_paths`) so a non-UTF-8
   path can't crash the audit before restore — fixes the shipped-keystone CRITICAL regardless.
4. **`run_card` ref parity or documented OS-sandbox residual** — agents share the gitdir by design;
   either adopt clone-per-agent or document ref-tamper as an OS-sandbox residual alongside the
   existing setsid-detached / absolute-path residuals in the HONEST BOUNDARY.

LOW/cosmetic: secret scan could also cover filenames + rename destinations.

## Decision (2026-07-08)
Keep STAGED. The gate is a large, real improvement over the original naked-exec, but ref-containment
wants isolation, not patches. Land after the clone redesign + one more council pass.
