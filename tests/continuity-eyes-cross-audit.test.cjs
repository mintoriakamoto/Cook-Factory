'use strict';

/**
 * MILESTONE v1.13 Wave 4: continuity eyes cross-audit (execute-phase step 5.9
 * extension per the ui-phase 9.7 idiom), ferrox-method-reviewer port (A7),
 * and the A3 retcon sweep wiring.
 *
 * Text-contract assertions in the canon-binding-wiring idiom: the workflow
 * surfaces are prompts, not executable code, so the contract is that the
 * exact shipped text is present, the eyes/gate split holds (no rule owned by
 * 2 tiers), the A2 caps and batch-wrapper rules ride the resolve-or-waive
 * loop, and the software path plus ui-phase 9.7 are untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const EXEC = read('ferrox-core/workflows/execute-phase.md');
const UI_PHASE = read('ferrox-core/workflows/ui-phase.md');
const CANON_INIT = read('ferrox-core/workflows/canon-init.md');
const KEEPER = read('agents/ferrox-lore-keeper.md');
const REVIEWER = read('agents/ferrox-method-reviewer.md');
const CATALOG = JSON.parse(read('ferrox-core/bin/shared/model-catalog.json'));
const INVENTORY = read('docs/INVENTORY-MANIFEST.json');

// The cross-audit block lives inside step 5.9, between the research floor
// paragraph and step 6.
const AUDIT = (() => {
  const start = EXEC.indexOf('**Continuity eyes cross-audit (v1.13 Wave 4;');
  const end = EXEC.indexOf('6. **Report completion');
  assert.ok(start > -1, 'cross-audit block heading must exist');
  assert.ok(end > start, 'cross-audit block must sit before step 6');
  return EXEC.slice(start, end);
})();

// ─── 1. The 2-eye dispatch (9.7 idiom transposed) ────────────────────────────

test('W4-01: cross-audit fires the eyes in a single message, 9.7 idiom', () => {
  assert.match(AUDIT, /the ui-phase 9\.7 idiom transposed/);
  assert.match(AUDIT, /fire every eye this wave needs in a SINGLE message and wait/);
  assert.match(AUDIT, /wall clock is the slower eye, not the sum/);
  assert.match(AUDIT, /2 parallel dispatches/);
});

test('W4-02: book eye is ferrox-continuity-checker with INDET + advisory handoff', () => {
  assert.match(AUDIT, /agents\/ferrox-continuity-checker\.md/);
  assert.match(AUDIT, /subagent_type="ferrox-continuity-checker"/);
  assert.match(AUDIT, /<gate_indet_items>\{raw INDET LC-\* lines from the lore gate, verbatim/);
  assert.match(AUDIT, /<gate_advisories>\{raw WARN lines from the lore gate, verbatim/);
});

test('W4-03: research eye is ferrox-method-reviewer with the CS-03 INDET slice', () => {
  assert.match(AUDIT, /agents\/ferrox-method-reviewer\.md/);
  assert.match(AUDIT, /subagent_type="ferrox-method-reviewer"/);
  assert.match(AUDIT, /<gate_indet_items>\{raw INDET CS-03 lines from the citation gate, verbatim/);
  assert.match(AUDIT, /SOURCES\.md \(project root, the ledger with stored excerpts\)/);
});

test('W4-04: no rule owned by 2 tiers; prose quality stays Crucible-routed', () => {
  assert.match(AUDIT, /No rule is owned by 2 tiers/);
  assert.match(AUDIT, /eyes receive only the INDET and WARN lines plus the artifacts/);
  assert.match(AUDIT, /Prose quality is NOT an eye/);
  assert.match(AUDIT, /stays Crucible-routed by the universal gate-first routing consult \(UGE-08\)/);
});

test('W4-05: step 5.9 INDET stubs now route into the cross-audit blocks', () => {
  assert.match(EXEC, /continuity-eyes cross-audit below as named judgment items in the book eye's\s+`<gate_indet_items>` block/);
  assert.match(EXEC, /\(ferrox-method-reviewer\) below in its `<gate_indet_items>` block/);
  assert.ok(!EXEC.includes('until that step exists'), 'chapter-path stub must be completed');
  assert.ok(!EXEC.includes('until it exists'), 'research-path stub must be completed');
});

// ─── 2. Resolve-or-waive: A2 caps, batch wrapper, loud waivers ───────────────

test('W4-06: BLOCK routing carries the A2 caps on both lanes', () => {
  assert.match(AUDIT, /`CONTINUITY_BREAK` or `TIMELINE_INVERSION` at HIGH/);
  assert.match(AUDIT, /Re-dispatch ferrox-chapter-drafter in revision mode with the findings as revision\s+context, max 2 passes, then stop honestly/);
  assert.match(AUDIT, /capped executor revision pass, max 2, then\s+stop honestly/);
  assert.match(AUDIT, /Never\s+hand these to the line-editor/);
  assert.match(AUDIT, /re-run the lore gate on the revised chapter/);
  assert.match(AUDIT, /Re-run the citation gate on the revised report/);
});

test('W4-07: style findings route through the line-editor batch wrapper rules', () => {
  assert.match(AUDIT, /route to ferrox-line-editor inside the A2 batch wrapper/);
  assert.match(AUDIT, /group findings per chapter/);
  assert.match(AUDIT, /tier triage ONCE up front/);
  assert.match(AUDIT, /apply bottom-up so line anchors never\s+shift/);
  assert.match(AUDIT, /1 atomic commit per chapter plus an EDIT-LOG entry/);
  assert.match(AUDIT, /the\s+continuity eye never emits style/);
});

test('W4-08: waivers are loud and land in a Continuity Waivers section', () => {
  assert.match(AUDIT, /`## Continuity Waivers` section of the wave summary \(finding, reason, who waived, date\)/);
  assert.match(AUDIT, /A waiver is loud, never silent/);
  assert.match(AUDIT, /recommendation first/);
  assert.match(AUDIT, /do not report it complete as clean/);
});

// ─── 3. ferrox-method-reviewer registration (A7 port) ───────────────────────

test('W4-09: method-reviewer agent file ports ijfw with credit and the eye contract', () => {
  assert.match(REVIEWER, /name: ferrox-method-reviewer/);
  assert.match(REVIEWER, /Adapted from ijfw \(Sean Donahoe, internal\)\./);
  assert.match(REVIEWER, /INDET CS-03/);
  assert.match(REVIEWER, /CLAIM_NOT_SUPPORTED/);
  assert.match(REVIEWER, /QUOTE_MEANING_SHIFT/);
  assert.match(REVIEWER, /never fetch a URL/i);
  assert.match(REVIEWER, /METHOD-REVIEW-<artifact>\.md/);
  assert.match(REVIEWER, /gate_indet_items/);
});

test('W4-10: method-reviewer registered in the model catalog and the INVENTORY manifest', () => {
  const row = CATALOG.agents['ferrox-method-reviewer'];
  assert.ok(row, 'model-catalog row must exist');
  assert.equal(row.phaseType, 'verification');
  assert.equal(row.routingTier, 'light');
  assert.ok(INVENTORY.includes('ferrox-method-reviewer'), 'INVENTORY-MANIFEST must list the agent');
});

// ─── 4. A3 retcon sweep wiring ───────────────────────────────────────────────

test('W4-11: canon-init carries the retcon sweep instructions', () => {
  assert.match(CANON_INIT, /## Step 6: Retcon sweep \(A3/);
  assert.match(CANON_INIT, /grep -rn "canon_facts_hash:" \.planning\//);
  assert.match(CANON_INIT, /VOID, not failed/);
  assert.match(CANON_INIT, /re-run `node gates\/lore-consistency\/gate\.cjs` exactly as execute-phase step 5\.9 does/);
  assert.match(CANON_INIT, /\*\*retcon the bible back:\*\*/);
  assert.match(CANON_INIT, /\*\*revise the chapter:\*\* the A2 lane, ferrox-chapter-drafter revision mode, max 2/);
  assert.match(CANON_INIT, /\*\*waive loud:\*\*/);
});

test('W4-12: keeper update mode points at the sweep but never performs it', () => {
  assert.match(KEEPER, /re-gate sweep lives in the canon-init workflow's retcon sweep step \(Step 6\)/);
  assert.match(KEEPER, /retcon back \/ revise via the A2 lane \/ waive loud/);
  assert.match(KEEPER, /it never triggers or performs the sweep/);
});

// ─── 5. Negative: software path and ui-phase 9.7 untouched ──────────────────

test('W4-13: software path in step 5.9 and step 6 is untouched', () => {
  assert.match(EXEC, /Skip this step entirely when `NONCODE_DOMAIN` is false\./);
  assert.match(EXEC, /6\. \*\*Report completion — spot-check claims first:\*\*/);
  assert.match(EXEC, /Verify first 2 files from `key-files\.created` exist on disk/);
  // The cross-audit lives INSIDE the NONCODE_DOMAIN-only step; nothing about it
  // leaks into the software wave-close path between step 6 and step 9.
  const after = EXEC.slice(EXEC.indexOf('6. **Report completion'));
  assert.ok(!after.includes('Continuity eyes cross-audit'), 'no cross-audit text after step 6');
  assert.ok(!after.includes('ferrox-method-reviewer'), 'no eye dispatch after step 6');
});

test('W4-14: ui-phase 9.7 design eyes block is untouched', () => {
  assert.match(UI_PHASE, /## 9\.7\. Design Eyes Cross-Audit \(2 parallel independent eyes\)/);
  assert.match(UI_PHASE, /subagent_type="ferrox-design-critic"/);
  assert.match(UI_PHASE, /subagent_type="ferrox-a11y-design-reviewer"/);
  assert.match(UI_PHASE, /`## Design Eyes Waivers` section of the UI-SPEC/);
  assert.ok(!UI_PHASE.includes('ferrox-method-reviewer'), 'ui-phase gains no research eye');
  assert.ok(!UI_PHASE.includes('ferrox-continuity-checker'), 'ui-phase gains no book eye');
});
