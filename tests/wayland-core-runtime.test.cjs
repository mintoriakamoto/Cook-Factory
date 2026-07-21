'use strict';

/**
 * REACH-WCORE-01 (v1.1 Phase E) — Wayland Core is a recognized Ferrox runtime.
 *
 * Wayland Core (~/dev/waylandcore) is a Rust-native agent engine with a
 * Claude-Code-shaped skin (AGENTS.md, markdown skills, Claude model aliases, MCP).
 * This locks that Ferrox RECOGNIZES it as the 19th runtime and projects the right
 * instruction file — honest about its Tier-2 limits (3 hook events; owns its own
 * loop, so the node CLI is a skills/MCP bridge, not the orchestrator).
 *
 * Live install against ~/dev/waylandcore is intentionally NOT exercised here — it
 * is Sean's active repo (never modified). That verification is FF-B25.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runtimes } = require('../ferrox-core/bin/lib/capability-registry.cjs');
const namePolicy = require('../ferrox-core/bin/lib/runtime-name-policy.cjs');

test('REACH-WCORE-01: wayland-core is a registered runtime capability', () => {
  const wc = runtimes['wayland-core'];
  assert.ok(wc, 'wayland-core must be in the capability registry');
  assert.equal(wc.role, 'runtime');
});

test('REACH-WCORE-01: wayland-core projects AGENTS.md as its instruction file', () => {
  assert.equal(namePolicy.getProjectInstructionFile('wayland-core'), 'AGENTS.md');
});

test('REACH-WCORE-01: the descriptor is HONEST about the 3-event hook gap', () => {
  const hb = runtimes['wayland-core'].runtime.hostBehaviors;
  assert.deepEqual(hb.hookEventsSupported, ['pre_tool_use', 'post_tool_use', 'stop']);
  // the merge-gate attaches via pre_tool_use — the one event that matters for the gate
  assert.ok(hb.hookEventsSupported.includes('pre_tool_use'));
});

test('REACH-WCORE-01: the descriptor records that wcore owns the loop (node CLI is a bridge)', () => {
  const hb = runtimes['wayland-core'].runtime.hostBehaviors;
  assert.equal(hb.ownsAgentLoop, true);
  assert.equal(hb.nodeCliRole, 'skills-and-mcp-bridge');
  // passive model mode — the host resolves models, Ferrox stays provider-agnostic
  assert.equal(runtimes['wayland-core'].runtime.hostIntegration.modelMode, 'passive');
});
