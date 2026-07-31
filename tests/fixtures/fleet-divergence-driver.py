#!/usr/bin/env python3
"""Phase 18 plan 02 task 4: the behaviour drivers for the 3 SC4 divergences.

Every mode below is pointed at a BIN DIRECTORY holding a complete copy of the vendored engine, so
the same driver runs unchanged against the reconstructed pristine copy, against a copy carrying
only DIV-02, and against the shipped copy. The caller compares the 3 results; this file states no
expectation of its own, because a driver that knows which arm it is in can be written to agree with
itself.

The exec entrypoint is loaded AS A LIBRARY by file location. Plan 01 established that every
vendored entrypoint carries exactly 1 main guard, so importing one executes no verb.

Every mode prints exactly 1 line beginning with RESULT, followed by JSON.
"""
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time


def load(bindir):
    target = os.path.join(bindir, "ratchet-exec")
    spec = importlib.util.spec_from_loader(
        "rexec_under_test", importlib.machinery.SourceFileLoader("rexec_under_test", target))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run(args, **kw):
    return subprocess.run(args, capture_output=True, **kw)


def emit(payload):
    print("RESULT " + json.dumps(payload))
    return 0


def git_repo_with_worktree(tmp):
    """A canonical repository plus a LINKED worktree, which is the shape a card tree has: its .git
    is a FILE pointing at the canonical common gitdir."""
    repo = os.path.join(tmp, "repo")
    wt = os.path.join(tmp, "wt")
    run(["git", "init", "-q", "-b", "main", repo])
    run(["git", "-C", repo, "config", "user.email", "t@t"])
    run(["git", "-C", repo, "config", "user.name", "t"])
    with open(os.path.join(repo, "a.txt"), "w") as fh:
        fh.write("a\n")
    run(["git", "-C", repo, "add", "."])
    run(["git", "-C", repo, "commit", "-qm", "c0"])
    run(["git", "-C", repo, "worktree", "add", "-q", "-b", "feat/lane", wt])
    return repo, wt


# The undecodable path is planted THROUGH THE GIT INDEX rather than on disk, because APFS refuses
# to create a filename that is not valid UTF-8 (observed: OSError errno 92, Illegal byte sequence).
# The index accepts arbitrary bytes, and `git status --porcelain -z` then emits them raw, which is
# exactly the input that made the strict decode raise.
BAD_NAME = b"bad\xff\xfename.txt"
PLANT_SH = (
    'O=$(git hash-object -w --stdin </dev/null); '
    "B=$(printf 'bad\\377\\376name.txt'); "
    'git update-index --add --cacheinfo "100644,$O,$B"; '
)


def mode_supervise(bindir, nbytes):
    """DIV-01. Drive the supervisor with a child that writes nbytes and exits."""
    m = load(bindir)
    payload = ("import sys;sys.stdout.buffer.write(b'A'*%d);sys.stdout.buffer.write(b'ZTAILZ')"
               % nbytes)
    proc = subprocess.Popen([sys.executable, "-c", payload], stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, start_new_session=True)
    reaped, raw = m._supervise(proc, time.time() + 300)
    proc.wait()
    return emit({
        "wrote": nbytes + 6,
        "returned": len(raw),
        "reaped": reaped,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "tail": raw[-6:].decode("ascii", "replace"),
        "cap": getattr(m, "_OUT_CAP", None),
    })


def mode_decode(bindir):
    """DIV-02, the exact call run_card makes at the containment audit: _changed_paths."""
    m = load(bindir)
    with tempfile.TemporaryDirectory(prefix="fdiv-decode-") as tmp:
        _repo, wt = git_repo_with_worktree(tmp)
        snap = m._snapshot(wt)
        blob = run(["git", "-C", wt, "hash-object", "-w", "--stdin"], input=b"x").stdout
        blob = blob.decode().strip()
        rc = subprocess.run(
            [b"git", b"-C", wt.encode(), b"update-index", b"--add", b"--cacheinfo",
             ("100644,%s," % blob).encode() + BAD_NAME], capture_output=True).returncode
        raw = run(["git", "-C", wt, "status", "--porcelain", "-z"]).stdout
        out = {"planted_rc": rc, "git_emits_raw_bytes": BAD_NAME in raw}
        try:
            paths = m._changed_paths(wt, snap)
            out["raised"] = None
            out["paths_repr"] = [repr(p) for p in paths]
            out["roundtrips"] = any(os.fsencode(p) == BAD_NAME for p in paths)
        except Exception as e:                          # noqa: BLE001 — the defect IS an exception
            out["raised"] = type(e).__name__
            out["message"] = str(e)
            out["roundtrips"] = False
        return emit(out)


def mode_audit_throw(bindir):
    """DIV-02 half 2. Force the containment audit to throw and observe whether the restore ran.

    _restore is wrapped by a recorder rather than inferred from the tree, because on the shipped
    copy the suite runs inside a throwaway clone that is deleted afterwards, and a clean card tree
    would then be explained by the deletion rather than by the restore.
    """
    m = load(bindir)
    with tempfile.TemporaryDirectory(prefix="fdiv-throw-") as tmp:
        _repo, wt = git_repo_with_worktree(tmp)
        calls = []
        real_restore = m._restore

        def recording_restore(target, snap):
            calls.append(target)
            return real_restore(target, snap)

        def exploding_changed_paths(*_a, **_kw):
            raise RuntimeError("planted containment audit failure")

        m._restore = recording_restore
        m._changed_paths = exploding_changed_paths
        out = {}
        try:
            res = m.guarded_suite(wt, "echo pwn > pwned.txt", timeout=60)
            out["raised"] = None
            out["violations"] = res["violations"]
            out["restore_ok"] = res["restore_ok"]
            out["ok"] = res["ok"]
        except Exception as e:                          # noqa: BLE001 — the defect IS an exception
            out["raised"] = type(e).__name__
            out["message"] = str(e)
        out["restore_calls"] = len(calls)
        dirty = run(["git", "-C", wt, "status", "--porcelain"]).stdout.decode("utf-8", "replace")
        out["card_tree_dirty"] = dirty.strip()
        out["pwned_in_card_tree"] = os.path.exists(os.path.join(wt, "pwned.txt"))
        return emit(out)


def mode_hook_survival(bindir):
    """DIV-02 end to end, the HIGH exploit. An untrusted suite plants an undecodable path in the
    index and injects a post-commit hook into the resolved hooks directory, which for a linked
    worktree is the CANONICAL repository's hooks directory. The undecodable path makes the audit
    raise before the restore, so the hook survives."""
    m = load(bindir)
    with tempfile.TemporaryDirectory(prefix="fdiv-hook-") as tmp:
        repo, wt = git_repo_with_worktree(tmp)
        probe = os.path.join(tmp, "probe.bin")
        cmd = (
            'HD=$(git rev-parse --git-path hooks); mkdir -p "$HD"; '
            "printf '#!/bin/sh\\necho RATCHETPWN\\n' > \"$HD/post-commit\"; "
            'chmod +x "$HD/post-commit"; '
            + PLANT_SH
            + 'git status --porcelain -z > "%s"; echo planted' % probe
        )
        out = {}
        try:
            res = m.guarded_suite(wt, cmd, timeout=120)
            out["raised"] = None
            out["violations"] = res["violations"]
            out["restore_ok"] = res["restore_ok"]
            out["ok"] = res["ok"]
        except Exception as e:                          # noqa: BLE001 — the defect IS an exception
            out["raised"] = type(e).__name__
            out["message"] = str(e)
        try:
            with open(probe, "rb") as fh:
                out["stimulus_reached_the_index"] = BAD_NAME in fh.read()
        except OSError:
            out["stimulus_reached_the_index"] = False
        hook = os.path.join(repo, ".git", "hooks", "post-commit")
        out["canonical_hook_path"] = hook
        out["canonical_hook_present"] = os.path.exists(hook)
        out["canonical_hook_body"] = ""
        if out["canonical_hook_present"]:
            with open(hook, encoding="utf-8", errors="replace") as fh:
                out["canonical_hook_body"] = fh.read().strip()
        dirty = run(["git", "-C", wt, "status", "--porcelain"]).stdout.decode("utf-8", "replace")
        out["card_tree_dirty"] = dirty.strip()
        return emit(out)


def mode_suite_escape(bindir):
    """DIV-03, the gate half. The hostile command writes an ordinary file into whatever directory
    `git rev-parse --git-common-dir` reports. Upstream's restore covers hooks, config, refs and
    worktree files and does NOT delete an arbitrary file in the common git directory, so the
    artifact is a durable observable."""
    m = load(bindir)
    with tempfile.TemporaryDirectory(prefix="fdiv-suite-") as tmp:
        repo, wt = git_repo_with_worktree(tmp)
        cmd = 'echo pwn > "$(git rev-parse --git-common-dir)/RATCHET_SUITE_PWN.txt"; echo done'
        out = {}
        try:
            res = m.guarded_suite(wt, cmd, timeout=120)
            out["raised"] = None
            out["rc"] = res["rc"]
            out["ok"] = res["ok"]
            out["violations"] = res["violations"]
        except Exception as e:                          # noqa: BLE001
            out["raised"] = type(e).__name__
            out["message"] = str(e)
        artifact = os.path.join(repo, ".git", "RATCHET_SUITE_PWN.txt")
        out["canonical_artifact_path"] = artifact
        out["canonical_artifact_present"] = os.path.exists(artifact)
        dirty = run(["git", "-C", repo, "status", "--porcelain"]).stdout.decode("utf-8", "replace")
        out["canonical_status"] = dirty.strip()
        return emit(out)


def mode_agent_escape(bindir):
    """DIV-03, the agent half, and the one phase 19 executes. Builds the same rig the vendored
    selftest builds, takes a card, and runs the mock adapter with a hostile command that writes
    into the common git directory AND produces a legitimate committed output file. The legitimate
    file is what stops the isolation from passing by discarding everything."""
    with tempfile.TemporaryDirectory(prefix="fdiv-agent-") as tmp:
        up = os.path.join(tmp, "up.git")
        seed = os.path.join(tmp, "seed")
        run(["git", "init", "-q", "--bare", up])
        run(["git", "init", "-q", "-b", "main", seed])
        run(["git", "-C", seed, "config", "user.email", "t@t"])
        run(["git", "-C", seed, "config", "user.name", "t"])
        with open(os.path.join(seed, "f.txt"), "w") as fh:
            fh.write("x\n")
        run(["git", "-C", seed, "add", "."])
        run(["git", "-C", seed, "commit", "-qm", "c0"])
        run(["git", "-C", seed, "remote", "add", "origin", up])
        run(["git", "-C", seed, "push", "-q", "origin", "main"])
        clone = os.path.join(tmp, "clone")
        run(["git", "clone", "-q", up, clone])
        run(["git", "-C", clone, "config", "user.email", "t@t"])
        run(["git", "-C", clone, "config", "user.name", "t"])
        mpath = os.path.join(tmp, "m.json")
        home = os.path.join(tmp, "home")
        os.makedirs(os.path.join(home, "state"), exist_ok=True)
        with open(mpath, "w") as fh:
            json.dump({"schema_version": 1, "min_wl_plane": "0", "repos": {"sb": {
                "path": clone, "mainline": "main", "fetch_remote": "origin", "push_remote": "origin",
                "gh_login": "t", "forbidden_push": [], "remotes": {"origin": up},
                "worktree_root": os.path.join(tmp, "wts")}},
                "noise_paths": [], "archive_dir": os.path.join(tmp, "arc"),
                "fetch_ttl_seconds": 300, "sync_warn_behind": 1, "sync_red_behind": 50}, fh)
        env = dict(os.environ, WL_HOME=home, WL_MANIFEST=mpath, WL_INSTANCE="fdiv",
                   PYTHONDONTWRITEBYTECODE="1")
        kern = os.path.join(bindir, "ratchet")
        exe = os.path.join(bindir, "ratchet-exec")
        run([sys.executable, kern, "take", "pwn-proof", "--repo", "sb", "--title", "pwn proof"],
            env=env)
        with open(os.path.join(home, "state", "workcards.json")) as fh:
            cards = json.load(fh)["cards"]
        wid = next(c["work_id"] for c in cards if c["slug"] == "pwn-proof")
        wtp = os.path.join(tmp, "wts", "wt-pwn-proof")
        mock = ('cd "$RATCHET_WORKTREE" && '
                'echo pwn > "$(git rev-parse --git-common-dir)/RATCHET_AGENT_PWN.txt" && '
                "echo legit > legit.txt && git add legit.txt && git commit -qm legit && echo done")
        p = run([sys.executable, exe, "run", wid, "--cli", "mock", "--grant", "*"],
                env=dict(env, RATCHET_MOCK_CMD=mock), timeout=600)
        stdout = p.stdout.decode("utf-8", "replace")
        rdir = os.path.join(home, "state", "recordings", wid)
        deliv = sorted(f for f in os.listdir(rdir) if f.startswith("delivery")) if os.path.isdir(rdir) else []
        dj = {}
        if deliv:
            with open(os.path.join(rdir, deliv[-1])) as fh:
                dj = json.load(fh)
        artifact = os.path.join(clone, ".git", "RATCHET_AGENT_PWN.txt")
        legit = os.path.join(wtp, "legit.txt")
        head = run(["git", "-C", wtp, "log", "--oneline", "-1"]).stdout.decode("utf-8", "replace")
        return emit({
            "rc": p.returncode,
            "verdict": dj.get("verdict"),
            "transfer_ok": dj.get("transfer_ok"),
            "isolated": dj.get("isolated"),
            "canonical_artifact_path": artifact,
            "canonical_artifact_present": os.path.exists(artifact),
            "legit_in_card_tree": os.path.exists(legit),
            "card_tree_head": head.strip(),
            "stdout_tail": stdout[-200:],
        })


def main():
    mode = sys.argv[1]
    bindir = sys.argv[2]
    if mode == "supervise":
        return mode_supervise(bindir, int(sys.argv[3]))
    if mode == "decode":
        return mode_decode(bindir)
    if mode == "audit-throw":
        return mode_audit_throw(bindir)
    if mode == "hook-survival":
        return mode_hook_survival(bindir)
    if mode == "suite-escape":
        return mode_suite_escape(bindir)
    if mode == "agent-escape":
        return mode_agent_escape(bindir)
    print("unknown mode %r" % mode, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
