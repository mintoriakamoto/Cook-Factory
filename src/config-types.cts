/**
 * TypeScript type definitions for Ferrox project config — model_policy block.
 *
 * These types reflect the model_policy config shape consumed by
 * resolveModelPolicy in model-resolver.cjs and validated by config-schema.cjs.
 * (core.cjs re-export spine retired in epic #1267)
 *
 * See feat #49 (model_policy presets) and config-schema.manifest.json.
 * Added under ADR-457: TS sources in src/ compile to CJS artifacts in
 * ferrox-core/bin/lib/ at publish time.
 *
 * Resolution precedence (highest → lowest):
 *   1. model_overrides[agent]
 *   2. model_policy.runtime_tiers[runtime][tier]   (Sub-path A)
 *   3. model_policy provider preset + budget        (Sub-path B)
 *   4. model_profile_overrides
 *   5. resolve_model_ids / profile fallback
 */

/**
 * A single tier entry mapping a Ferrox tier (opus | sonnet | haiku) to a
 * concrete model ID. The optional `reasoning_effort` field is forwarded to
 * runtimes that accept it (e.g. opencode).
 */
export interface TierEntry {
  model: string;
  reasoning_effort?: string;
}

/**
 * The three standard Ferrox tiers for one runtime target. All fields are
 * optional so callers can supply a partial override (e.g. only `opus`).
 */
export interface RuntimeTiers {
  low?: TierEntry;
  medium?: TierEntry;
  high?: TierEntry;
}

/**
 * Top-level `model_policy` block in `.planning/config.json`.
 *
 * - `provider`       — known provider slug (e.g. `"anthropic"`, `"openai"`).
 *                      Drives Sub-path B catalog lookup.
 * - `budget`         — optional spend/quality tier that pairs with `provider`
 *                      to select a preset from the model catalog.
 * - `runtime_tiers`  — explicit per-runtime, per-tier model overrides
 *                      (Sub-path A). Keys are runtime slugs (e.g. `"opencode"`,
 *                      `"copilot"`); values are `RuntimeTiers` maps.
 */
export interface ModelPolicyConfig {
  provider: string;
  budget?: string;
  runtime_tiers?: Record<string, RuntimeTiers>;
}

/**
 * The three terminal cap-outcomes a halting gate can resolve to (D-01).
 * A gate driven past its pass-cap or wall-clock budget fires exactly one of
 * these — never an open-ended "keep trying".
 */
export type HaltingCapOutcome =
  | 'ship-with-backlog'
  | 'stop-and-rescope'
  | 'escalate-to-human';

/**
 * Per-gate halting override. Keyed under `halting.gates.<gate-id>` in config.
 * All fields optional — the cap verbs (Plans 02-05) supply built-in fallbacks
 * for any gate the operator has not overridden.
 */
export interface HaltingGateConfig {
  /** Max passes before the gate fires its cap_outcome. */
  max_passes?: number;
  /** Wall-clock budget (seconds) before the gate fires its cap_outcome. */
  wall_clock_seconds?: number;
  /** Which terminal outcome this gate resolves to when a trigger fires. */
  cap_outcome?: HaltingCapOutcome;
}

/**
 * Top-level `halting` block in `.planning/config.json` (D-01). The single
 * config namespace every Phase-3 cap verb reads: overridable defaults for the
 * global rescope counter, human-SLA and ship-clock budgets, plus per-gate
 * pass/wall-clock caps keyed by gate id.
 */
export interface HaltingConfig {
  /** Global per-increment rescope attempt counter (default max_attempts = 2). */
  rescope?: {
    max_attempts?: number;
  };
  /** SLA (seconds) before an open human checkpoint is treated as breached. */
  human_sla_seconds?: number;
  /** Wall-clock budget (seconds) since the last coverage-advancing merge. */
  ship_clock_seconds?: number;
  /** Per-gate overrides, keyed by gate id (e.g. "plan-check", "wave-audit"). */
  gates?: Record<string, HaltingGateConfig>;
}

/**
 * Top-level `coordination` block in `.planning/config.json` (COORD-03, locked
 * decision 1). The single config namespace every Phase-4 coordination verb reads:
 * the hot-seam registry (globs that force GLOBAL write serialization), the
 * sole-writer protected shared-state paths, and the migration-sequence store.
 *
 * Modeled on {@link HaltingConfig}; all fields optional so a partial operator
 * block keeps the manifest defaults for the keys it did not override.
 */
export interface CoordinationConfig {
  /** Glob patterns that force GLOBAL serialization of writes (lockfiles,
   *  migrations, schema/DI/codegen files, and the FF-B12 halting-state files). */
  hot_seams?: string[];
  /** Sole-writer protected paths (STATE.md / ROADMAP.md / BACKLOG.md). */
  shared_state_paths?: string[];
  /** Path to the coordination migration-sequence store. */
  migration_store?: string;
}

/**
 * Minimal subset of the Ferrox project config that includes `model_policy`.
 * Extend this interface when migrating further config keys to TypeScript.
 */
export interface ProjectConfig {
  model_policy?: ModelPolicyConfig;
  halting?: HaltingConfig;
  coordination?: CoordinationConfig;
}
