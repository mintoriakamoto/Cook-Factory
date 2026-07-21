/**
 * INTG-04 park-and-continue blocker policy (v1.6 — WLD field report property #4).
 *
 * In an autonomous run, one blocked packet must NOT halt the whole fleet (today `autonomous.md`
 * dead-stops on the first blocker). This decides what to do with a blocker — while preserving Ferrox's
 * bounded-loop guarantee (a blocker is ALWAYS recorded and surfaced; the run never thrashes).
 *
 *   decideBlockerAction({ independentWorkRemaining, requiresHumanAuthority }) -> { action, surface, needsHuman, reason }
 *     park-and-continue — independent work remains: park this blocker, keep the fleet moving
 *     halt              — nothing else to do: stop cleanly (bounded), surface the blocker
 *   In BOTH cases the blocker is recorded (`surface: true`) into the consolidated receipt. A blocker
 *   that requiresHumanAuthority is parked+surfaced and NEVER auto-executed — but it still doesn't halt
 *   a fleet that has other independent work.
 *
 * FAIL-TOWARD-HALT-AND-SURFACE on garbage (bounded + visible, never silent, never thrash). Never throws.
 *
 * ADR-457: compiles to ferrox-core/bin/lib/blocker-policy.cjs. `export =` shape.
 */

interface BlockerDecision {
  action: 'park-and-continue' | 'halt';
  /** Always true — a blocker is never silently dropped; it lands in the consolidated receipt. */
  surface: boolean;
  /** True when this blocker needs a human authority decision (never auto-executed). */
  needsHuman: boolean;
  reason: string;
}

/**
 * PURE. `independentWorkRemaining === true` keeps the fleet moving (park this one); otherwise halt
 * cleanly. Every outcome surfaces the blocker.
 */
function decideBlockerAction(opts?: {
  independentWorkRemaining?: unknown;
  requiresHumanAuthority?: unknown;
}): BlockerDecision {
  const o = opts && typeof opts === 'object' ? opts : {};
  const needsHuman = o.requiresHumanAuthority === true;
  const canContinue = o.independentWorkRemaining === true;

  if (canContinue) {
    return {
      action: 'park-and-continue',
      surface: true,
      needsHuman,
      reason: needsHuman ? 'parked-needs-human-fleet-continues' : 'parked-fleet-continues',
    };
  }
  return {
    action: 'halt',
    surface: true,
    needsHuman,
    reason: needsHuman ? 'halt-needs-human-no-work-left' : 'halt-no-work-left',
  };
}

export = { decideBlockerAction };
