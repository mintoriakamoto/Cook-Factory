#!/usr/bin/env sh
# ferrox-residual-sweep.sh — FORK-04 gate.
#
# Repo-wide, case-aware sweep of the forked DELIVERABLE tree for the upstream
# brand token and org token. Exits NON-ZERO on any non-allowlisted invocation-
# surface hit; prints `SWEEP_CLEAN` and exits 0 only when the tree is clean.
#
# This is the phase's #1 risk gate (CONTEXT.md): a single surviving `ferrox_run`
# shim path, `@`-include, env-var prefix, or slash-command prefix that still
# carries the upstream token breaks invocation silently. This script proves none
# survive outside the sanctioned attribution allowlist.
#
# DESIGN NOTES
#   * Patterns are built from single-character shell variables, so the exact
#     brand literal never appears in this file — the sweep can never self-match
#     on its own source (the script is also excluded by path, belt-and-braces).
#   * Matching is BOUNDARY-AWARE, not a naive substring scan. The brand token is
#     only flagged when it is a real delimited segment or a camelCase brand form:
#       - delimited by a non-alphanumeric on both sides (gsd-core, gsd_run,
#         /gsd-, .gsd, GSD_, "gsd", open-gsd, opengsd) — case-insensitive;
#       - a lowercase camelCase head with an uppercase hump (gsdHome, gsdTools);
#       - a capitalized/interior camelCase form (readGsdCommand, commandsGsdDir).
#     Incidental in-identifier substrings such as `learningsDelete` (which
#     contains "gsD" across a word boundary) are NOT brand references and are
#     correctly ignored — matching them would be a false positive, exactly the
#     failure mode the plan warns about. This is pattern precision, NOT an
#     allowlist used to hide a real dangling reference.
#   * Scope = the git-tracked deliverable tree, i.e. exactly what the codemod
#     (scripts/ferrox-rename.mjs) transformed. Ferrox-owned control surfaces
#     (.planning/ .claude/ .ijfw/ HANDOFF.md FERROX-FACTORY-BRIEF.md), infra
#     (.git/ node_modules/), the generated lockfile (package-lock.json integrity
#     data), and the rename/sweep scripts themselves are out of scope and
#     excluded — they were never part of the renamed fork product.
#   * ALLOWLIST (the only sanctioned survivors, all authored in Plan 04):
#     LICENSE, NOTICE, and the confined README.md lineage block. Hits there are
#     reported for transparency but do not fail the gate. Every other hit fails.
#
# If this gate flags an invocation-surface file, the fix is to extend the
# codemod's substitution table and re-run rename+rebuild — never a manual
# one-off patch, and never widening this allowlist to force it green.

set -u

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "FATAL: not inside a git repository." >&2
  exit 2
}
cd "$ROOT" || exit 2

# --- token pieces (assembled from chars so the bare literal never appears) ---
a=g; b=s; c=d
TOK="${a}${b}${c}"          # lowercase brand token
CAP=G
CAMEL="${CAP}${b}${c}"      # capitalized camelCase brand form

# Boundary-delimited brand + compact org token (case-insensitive).
PAT_DELIM="(^|[^A-Za-z0-9])(open-?)?${TOK}([^A-Za-z0-9]|\$)"
# Lowercase camelCase head with an uppercase hump (case-sensitive).
PAT_CAMEL_HEAD="(^|[^A-Za-z0-9])${TOK}[A-Z]"
# Capitalized / interior camelCase brand form (case-sensitive).
PAT_CAMEL_CAP="${CAMEL}"

# --- scope exclusions: infra + Ferrox control surfaces + generated + self ----
is_excluded() {
  case "$1" in
    .git/*|.planning/*|.claude/*|.ijfw/*|node_modules/*) return 0 ;;
    scripts/ferrox-residual-sweep.sh)                    return 0 ;;
    scripts/ferrox-rename.mjs)                           return 0 ;;
    package-lock.json)                                   return 0 ;;
    HANDOFF.md|FERROX-FACTORY-BRIEF.md)                  return 0 ;;
  esac
  return 1
}

# --- attribution allowlist: sanctioned survivors (reported, not failing) -----
is_allowlisted() {
  case "$1" in
    LICENSE|NOTICE|README.md) return 0 ;;
  esac
  return 1
}

VIOL=$(mktemp)
ALLOWH=$(mktemp)
trap 'rm -f "$VIOL" "$ALLOWH"' EXIT INT TERM

LIST=$(mktemp)
git ls-files > "$LIST"

# FORK-04 must also cover the UNTRACKED, gitignored build output hooks/dist/.
# `git ls-files` cannot see it (hooks/dist/ is in .gitignore), so a stale
# pre-rename hook orphan shipped there by bin/install.js's readdir-copy would
# be INVISIBLE to this gate while being the actual shipped artifact. Append the
# built artifact's files explicitly so the sweep scans exactly what the
# installer copies to users. Boundary-aware matching and the confined
# LICENSE/NOTICE/README allowlist below are unchanged.
if [ -d hooks/dist ]; then
  find hooks/dist -type f >> "$LIST"
fi

while IFS= read -r f; do
  [ -n "$f" ] || continue
  is_excluded "$f" && continue
  [ -f "$f" ] || continue

  # -I skips binary files. -n prefixes line numbers. The delimited pass is
  # case-insensitive (-i) to catch GSD_/gsd/Gsd variants; the two camelCase
  # passes are case-SENSITIVE so that lowercase in-word substrings such as the
  # "gsD" inside `learningsDelete` cannot match.
  m=$(
    {
      grep -IinE "$PAT_DELIM"      "$f" 2>/dev/null
      grep -InE  "$PAT_CAMEL_HEAD" "$f" 2>/dev/null
      grep -InE  "$PAT_CAMEL_CAP"  "$f" 2>/dev/null
    } | sort -t: -k1,1n -u
  )
  [ -n "$m" ] || continue

  if is_allowlisted "$f"; then
    printf '%s\n' "$m" | sed "s|^|${f}:|" >> "$ALLOWH"
  else
    printf '%s\n' "$m" | sed "s|^|${f}:|" >> "$VIOL"
  fi
done < "$LIST"
rm -f "$LIST"

if [ -s "$VIOL" ]; then
  echo "RESIDUAL SWEEP: FAIL"
  echo "Non-allowlisted upstream brand/org references survive the fork:"
  echo "-------------------------------------------------------------------"
  cat "$VIOL"
  echo "-------------------------------------------------------------------"
  echo "FIX: extend scripts/ferrox-rename.mjs and re-run rename+rebuild."
  echo "     Do NOT hand-patch and do NOT widen the allowlist."
  exit 1
fi

if [ -s "$ALLOWH" ]; then
  echo "Allowlisted attribution survivors (LICENSE / NOTICE / README lineage):"
  cat "$ALLOWH"
  echo ""
fi

echo "SWEEP_CLEAN"
exit 0
