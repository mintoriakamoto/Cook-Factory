#!/usr/bin/env python3
"""Deterministic fixture generator for the test-generation gate pack.

Emits the reference bundle (known-STRONG suite) and the 5 FLUENT-BUT-WRONG
mutant bundles. ONLY this generator is committed: fixture content is generated
at validation time and sealed into the content-addressed store (FERROX_SEALED_STORE),
never written into a repo (ADR-SEALED-GATES decision 1). Because the generator
is byte-deterministic, the sealed hashes in card.md stay stable across machines.

Usage:
  generate_fixtures.py --out <dir>   writes reference.json + tg-m1.json..tg-m5.json
                                     and prints a manifest JSON with sha256 hashes.
  generate_fixtures.py --manifest    prints the manifest only, writes nothing.

Target module: interval utilities (merge/overlaps/total_covered). Chosen because
its comparison boundaries, slice arithmetic, and branch structure give the AST
mutation engine a rich, crash-free discrimination pool after trivial-mutant
pruning: every surviving mutant needs a real assertion to catch.
"""
import argparse
import hashlib
import json
import os
import sys

TARGET_FILENAME = "intervals.py"
SUITE_FILENAME = "test_intervals.py"

TARGET_SOURCE = '''\
"""Interval utilities: merge, overlap, and coverage measures for [start, end] pairs."""


def merge_intervals(intervals):
    """Merge overlapping or touching intervals into a sorted minimal list."""
    if not intervals:
        return []
    ordered = sorted([list(pair) for pair in intervals], key=lambda pair: (pair[0], pair[1]))
    merged = [ordered[0]]
    for start, end in ordered[1:]:
        last = merged[-1]
        if start <= last[1]:
            last[1] = max(last[1], end)
        else:
            merged.append([start, end])
    return merged


def overlaps(left, right):
    """True when the closed intervals share at least 1 point."""
    return left[0] <= right[1] and right[0] <= left[1]


def total_covered(intervals):
    """Total length covered by the union of the intervals."""
    return sum(end - start for start, end in merge_intervals(intervals))
'''

SMOKE_CALLS = [
    "merge_intervals([])",
    "merge_intervals([[3, 7]])",
    "merge_intervals([[1, 3], [2, 6], [8, 9], [5, 6]])",
    "overlaps([1, 5], [4, 9])",
    "overlaps([1, 2], [3, 4])",
    "overlaps([1, 5], [5, 9])",
    "total_covered([[1, 2], [4, 6]])",
]

DECLARED = {
    "kill_threshold": 0.7,
    "coverage_baseline": 40.0,
    "coverage_min_delta": 25.0,
}

REFERENCE_SUITE = '''\
"""Known-strong reference suite: boundary-complete, mutation-discriminative."""
import unittest

from intervals import merge_intervals, overlaps, total_covered


class TestMergeIntervals(unittest.TestCase):
    def test_empty_input_yields_an_empty_list(self):
        self.assertEqual(merge_intervals([]), [])

    def test_single_interval_passes_through(self):
        self.assertEqual(merge_intervals([[3, 7]]), [[3, 7]])

    def test_disjoint_intervals_come_back_sorted_and_separate(self):
        self.assertEqual(merge_intervals([[5, 6], [1, 2], [8, 9]]), [[1, 2], [5, 6], [8, 9]])

    def test_overlapping_intervals_merge(self):
        self.assertEqual(merge_intervals([[1, 3], [2, 6]]), [[1, 6]])

    def test_touching_intervals_merge_at_the_boundary(self):
        self.assertEqual(merge_intervals([[1, 2], [2, 3]]), [[1, 3]])

    def test_contained_interval_is_absorbed(self):
        self.assertEqual(merge_intervals([[1, 10], [2, 3]]), [[1, 10]])

    def test_unsorted_input_with_a_late_low_start(self):
        self.assertEqual(merge_intervals([[5, 6], [1, 10]]), [[1, 10]])

    def test_chain_of_overlaps_collapses_to_one(self):
        self.assertEqual(merge_intervals([[1, 4], [3, 5], [4, 9]]), [[1, 9]])

    def test_input_list_is_not_mutated(self):
        data = [[4, 5], [1, 2]]
        merge_intervals(data)
        self.assertEqual(data, [[4, 5], [1, 2]])


class TestOverlaps(unittest.TestCase):
    def test_overlapping_pair(self):
        self.assertTrue(overlaps([1, 5], [4, 9]))

    def test_touching_pair_counts_in_both_orders(self):
        self.assertTrue(overlaps([1, 5], [5, 9]))
        self.assertTrue(overlaps([5, 9], [1, 5]))

    def test_disjoint_pair_in_both_orders(self):
        self.assertFalse(overlaps([1, 2], [3, 4]))
        self.assertFalse(overlaps([3, 4], [1, 2]))

    def test_contained_pair(self):
        self.assertTrue(overlaps([3, 5], [1, 9]))


class TestTotalCovered(unittest.TestCase):
    def test_disjoint_lengths_sum(self):
        self.assertEqual(total_covered([[1, 2], [4, 6]]), 3)

    def test_overlap_is_counted_once(self):
        self.assertEqual(total_covered([[1, 4], [2, 6]]), 5)

    def test_empty_input_covers_nothing(self):
        self.assertEqual(total_covered([]), 0)


if __name__ == "__main__":
    unittest.main()
'''

# ---------------------------------------------------------------------------
# The 5 fluent-but-wrong suites. Each passes against the pristine target and
# reads as a plausible deliverable on a human skim; each fails the declared
# checks for a structurally different reason.
# ---------------------------------------------------------------------------

# tg-m1: high coverage, zero kill. Executes every branch of every function,
# asserts only types and non-nullness, so no behavioral mutant ever trips it.
MUTANT_M1_HIGH_COVERAGE_ZERO_KILL = '''\
"""Broad behavioural sweep of the interval utilities."""
import unittest

from intervals import merge_intervals, overlaps, total_covered


class TestIntervalBehaviour(unittest.TestCase):
    def test_merge_returns_a_list_for_varied_inputs(self):
        for data in ([], [[3, 7]], [[1, 3], [2, 6]], [[5, 6], [1, 2], [8, 9]]):
            result = merge_intervals(data)
            self.assertIsInstance(result, list)

    def test_merge_result_is_not_none_for_overlapping_chains(self):
        self.assertIsNotNone(merge_intervals([[1, 4], [3, 5], [4, 9]]))

    def test_overlaps_returns_a_boolean_for_all_relations(self):
        self.assertIsInstance(overlaps([1, 5], [4, 9]), bool)
        self.assertIsInstance(overlaps([1, 2], [3, 4]), bool)
        self.assertIsInstance(overlaps([1, 5], [5, 9]), bool)

    def test_total_covered_returns_an_integer(self):
        self.assertIsInstance(total_covered([[1, 2], [4, 6]]), int)
        self.assertIsInstance(total_covered([[1, 4], [2, 6]]), int)


if __name__ == "__main__":
    unittest.main()
'''

# tg-m2: happy path only. Correct expectations, but only for empty and
# single-interval inputs, so the merge logic, overlap logic, and boundaries
# are never exercised: kill rate collapses and coverage misses the loop body.
MUTANT_M2_HAPPY_PATH_ONLY = '''\
"""Core contract tests for merge_intervals."""
import unittest

from intervals import merge_intervals


class TestMergeIntervalsContract(unittest.TestCase):
    def test_empty_input_stays_empty(self):
        self.assertEqual(merge_intervals([]), [])

    def test_single_interval_is_returned_unchanged(self):
        self.assertEqual(merge_intervals([[2, 9]]), [[2, 9]])

    def test_single_negative_interval_is_returned_unchanged(self):
        self.assertEqual(merge_intervals([[-4, -1]]), [[-4, -1]])


if __name__ == "__main__":
    unittest.main()
'''

# tg-m3: self-comparing asserts that look rigorous. Every expectation compares
# an expression against the identical expression, so it can never disagree
# with the implementation, mutated or not.
MUTANT_M3_SELF_COMPARING = '''\
"""Determinism and stability checks for the interval utilities."""
import unittest

from intervals import merge_intervals, overlaps, total_covered


class TestIntervalConsistency(unittest.TestCase):
    def test_merge_is_deterministic_for_overlapping_input(self):
        self.assertEqual(merge_intervals([[1, 3], [2, 6]]), merge_intervals([[1, 3], [2, 6]]))

    def test_merge_is_deterministic_for_disjoint_input(self):
        self.assertEqual(
            merge_intervals([[5, 6], [1, 2], [8, 9]]),
            merge_intervals([[5, 6], [1, 2], [8, 9]]),
        )

    def test_merge_is_deterministic_for_empty_input(self):
        self.assertEqual(merge_intervals([]), merge_intervals([]))

    def test_overlaps_is_stable_across_calls(self):
        self.assertEqual(overlaps([1, 5], [4, 9]), overlaps([1, 5], [4, 9]))
        assert overlaps([1, 5], [5, 9]) == overlaps([1, 5], [5, 9])

    def test_total_covered_is_stable_across_calls(self):
        self.assertEqual(total_covered([[1, 2], [4, 6]]), total_covered([[1, 2], [4, 6]]))


if __name__ == "__main__":
    unittest.main()
'''

# tg-m4: golden values captured FROM the implementation at runtime. Passes
# today by construction and keeps passing under any behavioral mutant, because
# the oracle mutates together with the code under test.
MUTANT_M4_IMPLEMENTATION_ORACLE = '''\
"""Golden-value regression tests for the interval utilities."""
import unittest

from intervals import merge_intervals, overlaps, total_covered

GOLDEN_CASES = [
    [],
    [[3, 7]],
    [[1, 3], [2, 6]],
    [[1, 2], [2, 3]],
    [[5, 6], [1, 2], [8, 9]],
    [[1, 4], [3, 5], [4, 9]],
]


class TestMergeIntervalsGolden(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Golden expectations captured directly from the implementation.
        cls.golden = {repr(case): merge_intervals(case) for case in GOLDEN_CASES}

    def test_merge_matches_the_captured_golden_results(self):
        for case in GOLDEN_CASES:
            self.assertEqual(merge_intervals(case), self.golden[repr(case)])

    def test_total_covered_matches_the_derived_expectation(self):
        for case in GOLDEN_CASES:
            expected = sum(end - start for start, end in merge_intervals(case))
            self.assertEqual(total_covered(case), expected)

    def test_overlaps_agrees_with_merge_behaviour(self):
        merged = merge_intervals([[1, 5], [4, 9]])
        self.assertEqual(len(merged), 2 - overlaps([1, 5], [4, 9]))


if __name__ == "__main__":
    unittest.main()
'''

# tg-m5: games coverage with no-op sweeps. Lights up every line of the target
# through nested loops, then "asserts" only literal constants, so the suite
# proves execution and nothing else.
MUTANT_M5_COVERAGE_GAMER = '''\
"""Exhaustive execution sweep across the interval utility surface."""
import unittest

from intervals import merge_intervals, overlaps, total_covered

EXERCISE_MATRIX = [
    [],
    [[3, 7]],
    [[1, 3], [2, 6]],
    [[1, 2], [2, 3]],
    [[5, 6], [1, 2], [8, 9]],
    [[1, 4], [3, 5], [4, 9]],
    [[-4, -1], [-2, 3]],
]


class TestIntervalSweep(unittest.TestCase):
    def test_merge_sweep_completes_without_error(self):
        for case in EXERCISE_MATRIX:
            merge_intervals(case)
        assert True

    def test_overlap_sweep_completes_without_error(self):
        for case in EXERCISE_MATRIX:
            for other in EXERCISE_MATRIX:
                if case and other:
                    overlaps(case[0], other[0])
        assert True

    def test_total_sweep_completes_without_error(self):
        for case in EXERCISE_MATRIX:
            total_covered(case)
        assert True


if __name__ == "__main__":
    unittest.main()
'''

MUTANT_SUITES = {
    "tg-m1": MUTANT_M1_HIGH_COVERAGE_ZERO_KILL,
    "tg-m2": MUTANT_M2_HAPPY_PATH_ONLY,
    "tg-m3": MUTANT_M3_SELF_COMPARING,
    "tg-m4": MUTANT_M4_IMPLEMENTATION_ORACLE,
    "tg-m5": MUTANT_M5_COVERAGE_GAMER,
}


def build_bundle(suite_source):
    return {
        "schema": "ferrox.test-generation.bundle/1",
        "target": {"filename": TARGET_FILENAME, "source": TARGET_SOURCE},
        "suite": {"filename": SUITE_FILENAME, "source": suite_source},
        "smoke": SMOKE_CALLS,
        "declared": DECLARED,
    }


def bundle_bytes(suite_source):
    return (json.dumps(build_bundle(suite_source), sort_keys=True, indent=2) + "\n").encode("utf-8")


def all_bundles():
    out = {"reference": bundle_bytes(REFERENCE_SUITE)}
    for mutant_id, suite_source in sorted(MUTANT_SUITES.items()):
        out[mutant_id] = bundle_bytes(suite_source)
    return out


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", help="directory to write the bundle files into")
    parser.add_argument("--manifest", action="store_true", help="print the manifest only")
    args = parser.parse_args(argv[1:])
    if not args.out and not args.manifest:
        parser.error("pass --out <dir> or --manifest")

    manifest = {}
    for name, content in all_bundles().items():
        entry = {"sha256": hashlib.sha256(content).hexdigest()}
        if args.out:
            os.makedirs(args.out, exist_ok=True)
            file_path = os.path.join(args.out, "%s.json" % name)
            with open(file_path, "wb") as fh:
                fh.write(content)
            entry["file"] = file_path
        manifest[name] = entry
    print(json.dumps(manifest, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
