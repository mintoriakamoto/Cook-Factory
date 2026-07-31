/**
 * state.*, verify.*, init.*, phase.*, phases.*, validate.*, roadmap.*, and non-family alias/subcommand metadata for CJS routing.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/command-aliases.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

interface CommandAlias {
  canonical: string;
  aliases: string[];
  subcommand: string;
  mutation: boolean;
}

interface NonFamilyCommandAlias {
  canonical: string;
  aliases: string[];
  mutation: boolean;
}

export const STATE_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "state.load",
    "aliases": [],
    "subcommand": "load",
    "mutation": false
  },
  {
    "canonical": "state.json",
    "aliases": [
      "state json"
    ],
    "subcommand": "json",
    "mutation": false
  },
  {
    "canonical": "state.get",
    "aliases": [
      "state get"
    ],
    "subcommand": "get",
    "mutation": false
  },
  {
    "canonical": "state.update",
    "aliases": [
      "state update"
    ],
    "subcommand": "update",
    "mutation": true
  },
  {
    "canonical": "state.patch",
    "aliases": [
      "state patch"
    ],
    "subcommand": "patch",
    "mutation": true
  },
  {
    "canonical": "state.begin-phase",
    "aliases": [
      "state begin-phase"
    ],
    "subcommand": "begin-phase",
    "mutation": true
  },
  {
    "canonical": "state.advance-plan",
    "aliases": [
      "state advance-plan"
    ],
    "subcommand": "advance-plan",
    "mutation": true
  },
  {
    "canonical": "state.record-metric",
    "aliases": [
      "state record-metric"
    ],
    "subcommand": "record-metric",
    "mutation": true
  },
  {
    "canonical": "state.update-progress",
    "aliases": [
      "state update-progress"
    ],
    "subcommand": "update-progress",
    "mutation": true
  },
  {
    "canonical": "state.add-decision",
    "aliases": [
      "state add-decision"
    ],
    "subcommand": "add-decision",
    "mutation": true
  },
  {
    "canonical": "state.add-blocker",
    "aliases": [
      "state add-blocker"
    ],
    "subcommand": "add-blocker",
    "mutation": true
  },
  {
    "canonical": "state.resolve-blocker",
    "aliases": [
      "state resolve-blocker"
    ],
    "subcommand": "resolve-blocker",
    "mutation": true
  },
  {
    "canonical": "state.record-session",
    "aliases": [
      "state record-session"
    ],
    "subcommand": "record-session",
    "mutation": true
  },
  {
    "canonical": "state.signal-waiting",
    "aliases": [
      "state signal-waiting"
    ],
    "subcommand": "signal-waiting",
    "mutation": true
  },
  {
    "canonical": "state.signal-resume",
    "aliases": [
      "state signal-resume"
    ],
    "subcommand": "signal-resume",
    "mutation": true
  },
  {
    "canonical": "state.planned-phase",
    "aliases": [
      "state planned-phase"
    ],
    "subcommand": "planned-phase",
    "mutation": true
  },
  {
    "canonical": "state.validate",
    "aliases": [
      "state validate"
    ],
    "subcommand": "validate",
    "mutation": false
  },
  {
    "canonical": "state.sync",
    "aliases": [
      "state sync"
    ],
    "subcommand": "sync",
    "mutation": true
  },
  {
    "canonical": "state.prune",
    "aliases": [
      "state prune"
    ],
    "subcommand": "prune",
    "mutation": true
  },
  {
    "canonical": "state.rebuild",
    "aliases": [
      "state rebuild"
    ],
    "subcommand": "rebuild",
    "mutation": true
  },
  {
    "canonical": "state.milestone-switch",
    "aliases": [
      "state milestone-switch"
    ],
    "subcommand": "milestone-switch",
    "mutation": true
  },
  {
    "canonical": "state.add-roadmap-evolution",
    "aliases": [
      "state add-roadmap-evolution"
    ],
    "subcommand": "add-roadmap-evolution",
    "mutation": true
  }
];

export const VERIFY_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "verify.plan-structure",
    "aliases": [
      "verify plan-structure"
    ],
    "subcommand": "plan-structure",
    "mutation": false
  },
  {
    "canonical": "verify.phase-completeness",
    "aliases": [
      "verify phase-completeness"
    ],
    "subcommand": "phase-completeness",
    "mutation": false
  },
  {
    "canonical": "verify.references",
    "aliases": [
      "verify references"
    ],
    "subcommand": "references",
    "mutation": false
  },
  {
    "canonical": "verify.commits",
    "aliases": [
      "verify commits"
    ],
    "subcommand": "commits",
    "mutation": false
  },
  {
    "canonical": "verify.artifacts",
    "aliases": [
      "verify artifacts"
    ],
    "subcommand": "artifacts",
    "mutation": false
  },
  {
    "canonical": "verify.key-links",
    "aliases": [
      "verify key-links"
    ],
    "subcommand": "key-links",
    "mutation": false
  },
  {
    "canonical": "verify.schema-drift",
    "aliases": [
      "verify schema-drift"
    ],
    "subcommand": "schema-drift",
    "mutation": false
  },
  {
    "canonical": "verify.codebase-drift",
    "aliases": [
      "verify codebase-drift"
    ],
    "subcommand": "codebase-drift",
    "mutation": false
  }
];

export const INIT_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "init.execute-phase",
    "aliases": [
      "init execute-phase"
    ],
    "subcommand": "execute-phase",
    "mutation": false
  },
  {
    "canonical": "init.plan-phase",
    "aliases": [
      "init plan-phase"
    ],
    "subcommand": "plan-phase",
    "mutation": false
  },
  {
    "canonical": "init.new-project",
    "aliases": [
      "init new-project"
    ],
    "subcommand": "new-project",
    "mutation": false
  },
  {
    "canonical": "init.new-milestone",
    "aliases": [
      "init new-milestone"
    ],
    "subcommand": "new-milestone",
    "mutation": false
  },
  {
    "canonical": "init.onboard",
    "aliases": [
      "init onboard"
    ],
    "subcommand": "onboard",
    "mutation": false
  },
  {
    "canonical": "init.quick",
    "aliases": [
      "init quick"
    ],
    "subcommand": "quick",
    "mutation": false
  },
  {
    "canonical": "init.ingest-docs",
    "aliases": [
      "init ingest-docs"
    ],
    "subcommand": "ingest-docs",
    "mutation": false
  },
  {
    "canonical": "init.resume",
    "aliases": [
      "init resume"
    ],
    "subcommand": "resume",
    "mutation": false
  },
  {
    "canonical": "init.verify-work",
    "aliases": [
      "init verify-work"
    ],
    "subcommand": "verify-work",
    "mutation": false
  },
  {
    "canonical": "init.phase-op",
    "aliases": [
      "init phase-op"
    ],
    "subcommand": "phase-op",
    "mutation": false
  },
  {
    "canonical": "init.todos",
    "aliases": [
      "init todos"
    ],
    "subcommand": "todos",
    "mutation": false
  },
  {
    "canonical": "init.milestone-op",
    "aliases": [
      "init milestone-op"
    ],
    "subcommand": "milestone-op",
    "mutation": false
  },
  {
    "canonical": "init.map-codebase",
    "aliases": [
      "init map-codebase"
    ],
    "subcommand": "map-codebase",
    "mutation": false
  },
  {
    "canonical": "init.progress",
    "aliases": [
      "init progress"
    ],
    "subcommand": "progress",
    "mutation": false
  },
  {
    "canonical": "init.manager",
    "aliases": [
      "init manager"
    ],
    "subcommand": "manager",
    "mutation": false
  },
  {
    "canonical": "init.new-workspace",
    "aliases": [
      "init new-workspace"
    ],
    "subcommand": "new-workspace",
    "mutation": false
  },
  {
    "canonical": "init.list-workspaces",
    "aliases": [
      "init list-workspaces"
    ],
    "subcommand": "list-workspaces",
    "mutation": false
  },
  {
    "canonical": "init.remove-workspace",
    "aliases": [
      "init remove-workspace"
    ],
    "subcommand": "remove-workspace",
    "mutation": false
  }
];

export const PHASE_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "phase.uat-passed",
    "aliases": [
      "phase uat-passed"
    ],
    "subcommand": "uat-passed",
    "mutation": false
  },
  {
    "canonical": "phase.next-decimal",
    "aliases": [
      "phase next-decimal"
    ],
    "subcommand": "next-decimal",
    "mutation": false
  },
  {
    "canonical": "phase.add",
    "aliases": [
      "phase add"
    ],
    "subcommand": "add",
    "mutation": true
  },
  {
    "canonical": "phase.add-batch",
    "aliases": [
      "phase add-batch"
    ],
    "subcommand": "add-batch",
    "mutation": true
  },
  {
    "canonical": "phase.insert",
    "aliases": [
      "phase insert"
    ],
    "subcommand": "insert",
    "mutation": true
  },
  {
    "canonical": "phase.remove",
    "aliases": [
      "phase remove"
    ],
    "subcommand": "remove",
    "mutation": true
  },
  {
    "canonical": "phase.complete",
    "aliases": [
      "phase complete"
    ],
    "subcommand": "complete",
    "mutation": true
  },
  {
    "canonical": "phase.scaffold",
    "aliases": [
      "phase scaffold"
    ],
    "subcommand": "scaffold",
    "mutation": true
  },
  {
    "canonical": "phase.list-plans",
    "aliases": [
      "phase list-plans"
    ],
    "subcommand": "list-plans",
    "mutation": false
  }
];

export const PHASES_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "phases.list",
    "aliases": [
      "phases list"
    ],
    "subcommand": "list",
    "mutation": false
  },
  {
    "canonical": "phases.clear",
    "aliases": [
      "phases clear"
    ],
    "subcommand": "clear",
    "mutation": true
  },
  {
    "canonical": "phases.archive",
    "aliases": [
      "phases archive"
    ],
    "subcommand": "archive",
    "mutation": true
  }
];

export const VALIDATE_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "validate.consistency",
    "aliases": [
      "validate consistency"
    ],
    "subcommand": "consistency",
    "mutation": false
  },
  {
    "canonical": "validate.health",
    "aliases": [
      "validate health"
    ],
    "subcommand": "health",
    "mutation": false
  },
  {
    "canonical": "validate.agents",
    "aliases": [
      "validate agents"
    ],
    "subcommand": "agents",
    "mutation": false
  },
  {
    "canonical": "validate.context",
    "aliases": [
      "validate context"
    ],
    "subcommand": "context",
    "mutation": false
  }
];

export const ROADMAP_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "roadmap.analyze",
    "aliases": [
      "roadmap analyze"
    ],
    "subcommand": "analyze",
    "mutation": false
  },
  {
    "canonical": "roadmap.get-phase",
    "aliases": [
      "roadmap get-phase"
    ],
    "subcommand": "get-phase",
    "mutation": false
  },
  {
    "canonical": "roadmap.update-plan-progress",
    "aliases": [
      "roadmap update-plan-progress"
    ],
    "subcommand": "update-plan-progress",
    "mutation": true
  },
  {
    "canonical": "roadmap.annotate-dependencies",
    "aliases": [
      "roadmap annotate-dependencies"
    ],
    "subcommand": "annotate-dependencies",
    "mutation": true
  },
  {
    "canonical": "roadmap.validate",
    "aliases": [
      "roadmap validate"
    ],
    "subcommand": "validate",
    "mutation": false
  },
  {
    "canonical": "roadmap.upgrade",
    "aliases": [
      "roadmap upgrade"
    ],
    "subcommand": "upgrade",
    "mutation": true
  }
];

export const NON_FAMILY_COMMAND_ALIASES: NonFamilyCommandAlias[] = [
  {
    "canonical": "agent.classify-failure",
    "aliases": [
      "agent classify-failure"
    ],
    "mutation": false
  },
  {
    "canonical": "check-commit",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "check.decision-coverage-plan",
    "aliases": [
      "check decision-coverage-plan"
    ],
    "mutation": false
  },
  {
    "canonical": "check.decision-coverage-verify",
    "aliases": [
      "check decision-coverage-verify"
    ],
    "mutation": false
  },
  {
    "canonical": "commit",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "commit-to-subrepo",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "config-ensure-section",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "config-new-project",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "config-set",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "config-set-model-profile",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "docs-init",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "frontmatter.get",
    "aliases": [],
    "mutation": false
  },
  {
    "canonical": "frontmatter.merge",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "frontmatter.set",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "frontmatter.validate",
    "aliases": [
      "frontmatter validate"
    ],
    "mutation": true
  },
  {
    "canonical": "generate-claude-md",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "generate-claude-profile",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "generate-dev-preferences",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "learnings.copy",
    "aliases": [
      "learnings copy"
    ],
    "mutation": true
  },
  {
    "canonical": "learnings.delete",
    "aliases": [
      "learnings delete"
    ],
    "mutation": true
  },
  {
    "canonical": "learnings.prune",
    "aliases": [
      "learnings prune"
    ],
    "mutation": true
  },
  {
    "canonical": "milestone.complete",
    "aliases": [
      "milestone complete"
    ],
    "mutation": true
  },
  {
    "canonical": "phase.mvp-mode",
    "aliases": [
      "phase mvp-mode"
    ],
    "mutation": false
  },
  {
    "canonical": "progress.bar",
    "aliases": [
      "progress bar"
    ],
    "mutation": false
  },
  {
    "canonical": "requirements.mark-complete",
    "aliases": [
      "requirements mark-complete"
    ],
    "mutation": true
  },
  {
    "canonical": "stats.json",
    "aliases": [
      "stats json"
    ],
    "mutation": false
  },
  {
    "canonical": "task.is-behavior-adding",
    "aliases": [
      "task is-behavior-adding"
    ],
    "mutation": false
  },
  {
    "canonical": "template.fill",
    "aliases": [],
    "mutation": true
  },
  {
    "canonical": "template.select",
    "aliases": [
      "template select"
    ],
    "mutation": true
  },
  {
    "canonical": "todo.complete",
    "aliases": [
      "todo complete"
    ],
    "mutation": true
  },
  {
    "canonical": "todo.match-phase",
    "aliases": [
      "todo match-phase"
    ],
    "mutation": false
  },
  {
    "canonical": "uat.render-checkpoint",
    "aliases": [
      "uat render-checkpoint"
    ],
    "mutation": false
  },
  {
    "canonical": "verify-summary",
    "aliases": [
      "verify.summary",
      "verify summary"
    ],
    "mutation": false
  },
  {
    "canonical": "workstream.complete",
    "aliases": [
      "workstream complete"
    ],
    "mutation": true
  },
  {
    "canonical": "workstream.create",
    "aliases": [
      "workstream create"
    ],
    "mutation": true
  },
  {
    "canonical": "workstream.list",
    "aliases": [
      "workstream list"
    ],
    "mutation": false
  },
  {
    "canonical": "workstream.progress",
    "aliases": [
      "workstream progress"
    ],
    "mutation": true
  },
  {
    "canonical": "workstream.set",
    "aliases": [
      "workstream set"
    ],
    "mutation": true
  },
  {
    "canonical": "write-profile",
    "aliases": [],
    "mutation": true
  }
];

export const STATE_SUBCOMMANDS: string[] = STATE_COMMAND_ALIASES.map((entry) => entry.subcommand);
export const VERIFY_SUBCOMMANDS: string[] = VERIFY_COMMAND_ALIASES.map((entry) => entry.subcommand);
export const INIT_SUBCOMMANDS: string[] = INIT_COMMAND_ALIASES.map((entry) => entry.subcommand);
export const PHASE_SUBCOMMANDS: string[] = PHASE_COMMAND_ALIASES.map((entry) => entry.subcommand);
export const PHASES_SUBCOMMANDS: string[] = PHASES_COMMAND_ALIASES.map((entry) => entry.subcommand);
export const VALIDATE_SUBCOMMANDS: string[] = VALIDATE_COMMAND_ALIASES.map((entry) => entry.subcommand);
export const ROADMAP_SUBCOMMANDS: string[] = ROADMAP_COMMAND_ALIASES.map((entry) => entry.subcommand);

export const EVAL_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "eval.score",
    "aliases": ["eval score"],
    "subcommand": "score",
    "mutation": false
  }
];

export const EVAL_SUBCOMMANDS: string[] = EVAL_COMMAND_ALIASES.map((entry) => entry.subcommand);

// ─── Phase 3 halting-layer families (Plan 06) ──────────────────────────────────
// The five locked-name cap verbs (D-02): gate.cap-check, rescope.check,
// human-sla.check, ship-clock.check, coverage.delta. Each block mirrors the EVAL
// block: a single-subcommand family + its derived _SUBCOMMANDS export.

export const GATE_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "gate.cap-check",
    "aliases": ["gate cap-check"],
    "subcommand": "cap-check",
    "mutation": false
  },
  {
    "canonical": "gate.seal",
    "aliases": ["gate seal"],
    "subcommand": "seal",
    "mutation": true
  },
  {
    "canonical": "gate.verify-seal",
    "aliases": ["gate verify-seal"],
    "subcommand": "verify-seal",
    "mutation": false
  },
  {
    "canonical": "gate.sample-mutants",
    "aliases": ["gate sample-mutants"],
    "subcommand": "sample-mutants",
    "mutation": false
  }
];

export const GATE_SUBCOMMANDS: string[] = GATE_COMMAND_ALIASES.map((entry) => entry.subcommand);

// ─── MILESTONE v1.10 wave 1 visual companion family ─────────────────────────
// visual.start / visual.stop / visual.status: lifecycle verbs for the adapted
// visual companion server (ferrox-core/bin/visual/, adapted from Superpowers
// by Obra, MIT). Mirrors the GATE block shape.

export const VISUAL_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "visual.start",
    "aliases": ["visual start"],
    "subcommand": "start",
    "mutation": true
  },
  {
    "canonical": "visual.stop",
    "aliases": ["visual stop"],
    "subcommand": "stop",
    "mutation": true
  },
  {
    "canonical": "visual.status",
    "aliases": ["visual status"],
    "subcommand": "status",
    "mutation": false
  }
];

export const VISUAL_SUBCOMMANDS: string[] = VISUAL_COMMAND_ALIASES.map((entry) => entry.subcommand);

export const RESCOPE_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "rescope.check",
    "aliases": ["rescope check"],
    "subcommand": "check",
    "mutation": false
  }
];

export const RESCOPE_SUBCOMMANDS: string[] = RESCOPE_COMMAND_ALIASES.map((entry) => entry.subcommand);

export const HUMAN_SLA_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "human-sla.check",
    "aliases": ["human-sla check"],
    "subcommand": "check",
    "mutation": false
  }
];

export const HUMAN_SLA_SUBCOMMANDS: string[] = HUMAN_SLA_COMMAND_ALIASES.map((entry) => entry.subcommand);

export const SHIP_CLOCK_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "ship-clock.check",
    "aliases": ["ship-clock check"],
    "subcommand": "check",
    "mutation": false
  }
];

export const SHIP_CLOCK_SUBCOMMANDS: string[] = SHIP_CLOCK_COMMAND_ALIASES.map((entry) => entry.subcommand);

export const COVERAGE_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "coverage.delta",
    "aliases": ["coverage delta"],
    "subcommand": "delta",
    "mutation": false
  }
];

export const COVERAGE_SUBCOMMANDS: string[] = COVERAGE_COMMAND_ALIASES.map((entry) => entry.subcommand);

// ─── Phase 4 coordination-layer family (Plan 05) ───────────────────────────────
// One `coord` family, five locked-name subcommands registering the tested
// Phase-4 cores (Plans 02-04) into the dispatch layer: ownership-check,
// hot-seam-check, alloc-migration (MUTATION — writes the central store),
// check-migration, shared-write-check.

export const COORD_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "coord.ownership-check",
    "aliases": ["coord ownership-check"],
    "subcommand": "ownership-check",
    "mutation": false
  },
  {
    "canonical": "coord.hot-seam-check",
    "aliases": ["coord hot-seam-check"],
    "subcommand": "hot-seam-check",
    "mutation": false
  },
  {
    "canonical": "coord.alloc-migration",
    "aliases": ["coord alloc-migration"],
    "subcommand": "alloc-migration",
    "mutation": true
  },
  {
    "canonical": "coord.check-migration",
    "aliases": ["coord check-migration"],
    "subcommand": "check-migration",
    "mutation": false
  },
  {
    "canonical": "coord.shared-write-check",
    "aliases": ["coord shared-write-check"],
    "subcommand": "shared-write-check",
    "mutation": false
  },
  // FF-B15: consume-once guard for an allocated migration number. MUTATION —
  // writes the central store's `consumed` set (a replayed number is refused).
  {
    "canonical": "coord.consume-migration",
    "aliases": ["coord consume-migration"],
    "subcommand": "consume-migration",
    "mutation": true
  }
];

export const COORD_SUBCOMMANDS: string[] = COORD_COMMAND_ALIASES.map((entry) => entry.subcommand);

// ─── Phase 5 strength-layer family (Plan 07) ───────────────────────────────────
// One `strength` family, eight locked-name subcommands registering the tested
// Phase-5 strength cores (Plans 02-06) into the dispatch layer: judge-check,
// severity-route, receipt (MUTATION — writes the red-green receipt store),
// verify-receipt, mutation-check, burndown-check, coverage-source, merge-gate.

export const STRENGTH_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "strength.judge-check",
    "aliases": ["strength judge-check"],
    "subcommand": "judge-check",
    "mutation": false
  },
  {
    "canonical": "strength.severity-route",
    "aliases": ["strength severity-route"],
    "subcommand": "severity-route",
    "mutation": false
  },
  {
    "canonical": "strength.receipt",
    "aliases": ["strength receipt"],
    "subcommand": "receipt",
    "mutation": true
  },
  {
    "canonical": "strength.depth-decide",
    "aliases": ["strength depth-decide"],
    "subcommand": "depth-decide",
    "mutation": true
  },
  {
    "canonical": "strength.verify-receipt",
    "aliases": ["strength verify-receipt"],
    "subcommand": "verify-receipt",
    "mutation": false
  },
  {
    "canonical": "strength.mutation-check",
    "aliases": ["strength mutation-check"],
    "subcommand": "mutation-check",
    "mutation": false
  },
  {
    "canonical": "strength.burndown-check",
    "aliases": ["strength burndown-check"],
    "subcommand": "burndown-check",
    "mutation": false
  },
  {
    "canonical": "strength.coverage-source",
    "aliases": ["strength coverage-source"],
    "subcommand": "coverage-source",
    "mutation": false
  },
  {
    "canonical": "strength.coverage-baseline",
    "aliases": ["strength coverage-baseline"],
    "subcommand": "coverage-baseline",
    "mutation": true
  },
  {
    "canonical": "strength.merge-gate",
    "aliases": ["strength merge-gate"],
    "subcommand": "merge-gate",
    "mutation": false
  },
  {
    "canonical": "strength.cross-audit-cadence",
    "aliases": ["strength cross-audit-cadence"],
    "subcommand": "cross-audit-cadence",
    "mutation": false
  },
  {
    "canonical": "strength.classify-failures",
    "aliases": ["strength classify-failures"],
    "subcommand": "classify-failures",
    "mutation": false
  },
  {
    "canonical": "strength.integration-landing",
    "aliases": ["strength integration-landing"],
    "subcommand": "integration-landing",
    "mutation": false
  },
  {
    "canonical": "strength.blocker-policy",
    "aliases": ["strength blocker-policy"],
    "subcommand": "blocker-policy",
    "mutation": false
  },
  {
    "canonical": "strength.authority-check",
    "aliases": ["strength authority-check"],
    "subcommand": "authority-check",
    "mutation": false
  },
  {
    "canonical": "strength.quality-pipeline",
    "aliases": ["strength quality-pipeline"],
    "subcommand": "quality-pipeline",
    "mutation": false
  },
  // UGE-08: the UGE-01 domain->gate registry consult (selectGate / listGateDomains).
  {
    "canonical": "strength.gate-select",
    "aliases": ["strength gate-select"],
    "subcommand": "gate-select",
    "mutation": false
  }
];

export const STRENGTH_SUBCOMMANDS: string[] = STRENGTH_COMMAND_ALIASES.map((entry) => entry.subcommand);

// ─── Phase 6 model-tiering family (Plan 05) ────────────────────────────────────
// One `model` family, three locked-name subcommands registering the tested
// Phase-6 model cores (Plan 02) into the dispatch layer: route (MODEL-01),
// escalate (MODEL-02, the one-hop cap), risk-grade (MODEL-03). All read-only.

export const MODEL_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "model.route",
    "aliases": ["model route"],
    "subcommand": "route",
    "mutation": false
  },
  {
    "canonical": "model.escalate",
    "aliases": ["model escalate"],
    "subcommand": "escalate",
    "mutation": false
  },
  {
    "canonical": "model.risk-grade",
    "aliases": ["model risk-grade"],
    "subcommand": "risk-grade",
    "mutation": false
  },
  {
    "canonical": "model.backend",
    "aliases": ["model backend"],
    "subcommand": "backend",
    "mutation": false
  },
  // FF-B26 (v1.13 P2 W0, A13): bare tier->model resolve over the tier_models
  // ladder; the thin wrap of the model-backend ladderModel lookup.
  {
    "canonical": "model.resolve-tier",
    "aliases": ["model resolve-tier"],
    "subcommand": "resolve-tier",
    "mutation": false
  },
  {
    "canonical": "model.anvil-run",
    "aliases": ["model anvil-run"],
    "subcommand": "anvil-run",
    "mutation": true
  },
  // UGE-08: universal gate-first routing consult (UGE-06 predicate + crucible probe).
  {
    "canonical": "model.gate-first-eligibility",
    "aliases": ["model gate-first-eligibility"],
    "subcommand": "gate-first-eligibility",
    "mutation": false
  },
  // UGE-08: the native gate-first climb (UGE-05 driver). Read-only at the repo
  // seam — it only ever writes a CANDIDATE into scratch, which still faces the
  // unchanged verify + merge-gate (the ANV-03 taxonomy, natively).
  {
    "canonical": "model.gate-first-run",
    "aliases": ["model gate-first-run"],
    "subcommand": "gate-first-run",
    "mutation": false
  }
];

export const MODEL_SUBCOMMANDS: string[] = MODEL_COMMAND_ALIASES.map((entry) => entry.subcommand);

// ─── Phase 6 trident family (Plan 06) ──────────────────────────────────────────
// One `trident` family, one locked-name subcommand registering the tested Plan 03
// bounded cross-lineage audit core into the dispatch layer: audit (MODEL-04).
// Read-only — Trident is a DISCOVERY tool, never a mutation.

export const TRIDENT_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "trident.audit",
    "aliases": ["trident audit"],
    "subcommand": "audit",
    "mutation": false
  }
];

export const TRIDENT_SUBCOMMANDS: string[] = TRIDENT_COMMAND_ALIASES.map((entry) => entry.subcommand);

// ─── Phase 6 rtk family (Plan 06) ──────────────────────────────────────────────
// One `rtk` family, two locked-name subcommands registering the tested Plan 04
// rtk cores into the dispatch layer: wrap + report (MODEL-05). Read-only — both
// are decision/parse cores that emit a verdict, never mutate state.

export const RTK_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "rtk.wrap",
    "aliases": ["rtk wrap"],
    "subcommand": "wrap",
    "mutation": false
  },
  {
    "canonical": "rtk.report",
    "aliases": ["rtk report"],
    "subcommand": "report",
    "mutation": false
  }
];

export const RTK_SUBCOMMANDS: string[] = RTK_COMMAND_ALIASES.map((entry) => entry.subcommand);

// ─── Phase 7 memory-layer family (Plan 04) ─────────────────────────────────────
// One `memory` family, three locked-name subcommands registering the tested
// Phase-7 cores (Plans 02-03) into the dispatch layer: fact (MUTATION — the
// --op add/invalidate paths write the bi-temporal store), recall (read-only),
// capture (MUTATION — writes a decision fact, superseding a contradicted prior).

export const MEMORY_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "memory.fact",
    "aliases": ["memory fact"],
    "subcommand": "fact",
    "mutation": true
  },
  {
    "canonical": "memory.recall",
    "aliases": ["memory recall"],
    "subcommand": "recall",
    "mutation": false
  },
  {
    "canonical": "memory.capture",
    "aliases": ["memory capture"],
    "subcommand": "capture",
    "mutation": true
  }
];

export const MEMORY_SUBCOMMANDS: string[] = MEMORY_COMMAND_ALIASES.map((entry) => entry.subcommand);

// ─── Phase 15 anti-loop family (Plan 02) ───────────────────────────────────────
// One `antiloop` family, 4 locked-name subcommands registering the tested
// Phase-15 plan-01 fold into the dispatch layer: declare-budget (MUTATION —
// appends the budget event, refuses a second declaration), open-round
// (MUTATION — appends only when the fold permits the open), file-finding
// (MUTATION — records a finding with the fold's blocking verdict, never the
// requested one), status (read-only).
//
// There is deliberately no verb and no flag that supplies a round count, clears
// a counter, overrides a refusal, or carries a review past a spent budget.

export const ANTILOOP_COMMAND_ALIASES: CommandAlias[] = [
  {
    "canonical": "antiloop.declare-budget",
    "aliases": ["antiloop declare-budget"],
    "subcommand": "declare-budget",
    "mutation": true
  },
  {
    "canonical": "antiloop.open-round",
    "aliases": ["antiloop open-round"],
    "subcommand": "open-round",
    "mutation": true
  },
  {
    "canonical": "antiloop.file-finding",
    "aliases": ["antiloop file-finding"],
    "subcommand": "file-finding",
    "mutation": true
  },
  {
    "canonical": "antiloop.status",
    "aliases": ["antiloop status"],
    "subcommand": "status",
    "mutation": false
  }
];

export const ANTILOOP_SUBCOMMANDS: string[] = ANTILOOP_COMMAND_ALIASES.map((entry) => entry.subcommand);
