/**
 * milestone-manifest: the `MILESTONE-v*.md` / `BENCHMARK-v*.md` artifact contract.
 *
 * PURE parser + renderer for the milestone index (Phase 14, v1.14 Fleet Mode). Mirrors
 * the `team-manifest.cts` shape: a versioned artifact contract with a deterministic
 * parser, so `.planning/MILESTONES.md` can be GENERATED and drift-checked instead of
 * hand-maintained.
 *
 * WHY THIS EXISTS: `.planning/ROADMAP.md` went 365 commits without an update while 12
 * milestones shipped, and "what milestone are we on" ended up with 3 conflicting answers.
 * The rule adopted in response: every artifact claiming to describe current state must be
 * machine-derived, machine-checked for staleness, or deleted.
 *
 * HERMETIC BY CONTRACT (this is what makes `--check` meaningful):
 *   - no `child_process`, no `fs`, no `Date.now()`, no network
 *   - callers pass file contents in; this module never reads the disk
 *   - `collectMilestones` sorts EXPLICITLY and never relies on input order, so a
 *     filesystem enumeration change cannot alter the rendered output
 *
 * FAIL LOUD: a malformed artifact returns `{ok:false, code}` and is never silently
 * skipped. A silently dropped artifact is exactly how an index rots while looking healthy.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/milestone-manifest.cjs.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('../vendor/js-yaml-4.2.0.cjs') as {
  load(src: string): unknown;
};

const LIFECYCLES = ['draft', 'active', 'complete'] as const;
const KINDS = ['milestone', 'benchmark'] as const;

type Lifecycle = (typeof LIFECYCLES)[number];
type Kind = (typeof KINDS)[number];

interface MilestoneEntry {
  ok: true;
  milestone: string;
  name: string;
  lifecycle: Lifecycle;
  part: number;
  shipped: string[];
  artifact_kind: Kind;
  progress: { done: number; total: number };
  file: string;
}

interface MilestoneError {
  ok: false;
  code: string;
  message: string;
  file: string;
}

type ParseResult = MilestoneEntry | MilestoneError;

interface MilestoneGroup {
  milestone: string;
  name: string;
  lifecycle: Lifecycle;
  shipped: string[];
  artifact_kind: Kind;
  parts: MilestoneEntry[];
  progress: { done: number; total: number };
}

/** Version in a filename: MILESTONE-v1.13-NAME.md or BENCHMARK-v1.7.md */
const FILENAME_VERSION = /^(?:MILESTONE|BENCHMARK)-v(\d+(?:\.\d+)*)(?:-|\.md$)/;

function err(file: string, code: string, message: string): MilestoneError {
  return { ok: false, code, message, file };
}

/**
 * Compare two dotted numeric versions NUMERICALLY. "1.10" sorts after "1.9", which a
 * lexicographic compare gets wrong. Separately exported so it is directly testable.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Split leading YAML frontmatter from the body. Returns null when absent. */
function splitFrontmatter(text: string): { fm: string; body: string } | null {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = text.slice(4, end + 1);
  const afterMarker = text.indexOf('\n', end + 1);
  const body = afterMarker === -1 ? '' : text.slice(afterMarker + 1);
  return { fm, body };
}

/** Count `- [x]` / `- [ ]` checkboxes to derive progress. */
function countProgress(body: string): { done: number; total: number } {
  const done = (body.match(/^- \[x\]/gim) ?? []).length;
  const open = (body.match(/^- \[ \]/gim) ?? []).length;
  return { done, total: done + open };
}

/**
 * Parse one milestone artifact. `filename` is the basename; its version must match the
 * frontmatter `milestone`, so a renamed file cannot silently index under the wrong key.
 */
function parseMilestoneArtifact(text: unknown, filename: unknown): ParseResult {
  const file = typeof filename === 'string' ? filename : '<unknown>';
  if (typeof text !== 'string' || text.trim() === '') {
    return err(file, 'E_MILESTONE_EMPTY', 'artifact is empty or not a string');
  }

  const split = splitFrontmatter(text);
  if (split === null) {
    return err(file, 'E_MILESTONE_FRONTMATTER', 'missing YAML frontmatter block');
  }

  let fm: Record<string, unknown>;
  try {
    const loaded = yaml.load(split.fm);
    if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) {
      return err(file, 'E_MILESTONE_FRONTMATTER', 'frontmatter is not a mapping');
    }
    fm = loaded as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(file, 'E_MILESTONE_FRONTMATTER', `frontmatter is not valid YAML: ${msg}`);
  }

  const milestone = fm['milestone'];
  if (typeof milestone !== 'string' || !/^\d+(\.\d+)*$/.test(milestone)) {
    return err(file, 'E_MILESTONE_VERSION', 'milestone must be a quoted dotted-numeric string');
  }

  const m = FILENAME_VERSION.exec(file);
  if (m === null) {
    return err(file, 'E_MILESTONE_FILENAME', 'filename does not match MILESTONE-v<ver>- or BENCHMARK-v<ver>');
  }
  if (m[1] !== milestone) {
    return err(
      file,
      'E_MILESTONE_FILENAME_MISMATCH',
      `filename declares v${m[1]} but frontmatter declares ${milestone}`,
    );
  }

  const name = fm['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    return err(file, 'E_MILESTONE_NAME', 'name is required and must be a non-empty string');
  }

  const lifecycle = fm['lifecycle'];
  if (typeof lifecycle !== 'string' || !(LIFECYCLES as readonly string[]).includes(lifecycle)) {
    return err(file, 'E_MILESTONE_LIFECYCLE', `lifecycle must be one of: ${LIFECYCLES.join(', ')}`);
  }

  const kind = fm['artifact_kind'];
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    return err(file, 'E_MILESTONE_KIND', `artifact_kind must be one of: ${KINDS.join(', ')}`);
  }

  const shippedRaw = fm['shipped'];
  if (!Array.isArray(shippedRaw)) {
    return err(file, 'E_MILESTONE_SHIPPED', 'shipped must be a list (use [] when never published)');
  }
  const shipped: string[] = [];
  for (const v of shippedRaw) {
    if (typeof v !== 'string' || !/^\d+\.\d+\.\d+/.test(v)) {
      return err(file, 'E_MILESTONE_SHIPPED', `shipped entries must be semver strings, got ${JSON.stringify(v)}`);
    }
    shipped.push(v);
  }

  const partRaw = fm['part'];
  let part = 1;
  if (partRaw !== undefined) {
    if (typeof partRaw !== 'number' || !Number.isInteger(partRaw) || partRaw < 1) {
      return err(file, 'E_MILESTONE_PART', 'part must be a positive integer when present');
    }
    part = partRaw;
  }

  return {
    ok: true,
    milestone,
    name,
    lifecycle: lifecycle as Lifecycle,
    part,
    shipped,
    artifact_kind: kind as Kind,
    progress: countProgress(split.body),
    file,
  };
}

/**
 * Group parsed entries by version and sort deterministically.
 *
 * Order-stability is the contract: groups sort by numeric version, parts sort by `part`
 * then filename. Input order is never consulted, so a filesystem enumeration change
 * cannot alter the rendered index.
 *
 * Group metadata (`name`, `lifecycle`, `shipped`, `artifact_kind`) must AGREE across
 * parts. Disagreement is an error, never a last-write-wins merge.
 */
function collectMilestones(entries: ParseResult[]): {
  ok: boolean;
  groups: MilestoneGroup[];
  errors: MilestoneError[];
} {
  const errors: MilestoneError[] = [];
  const byVersion = new Map<string, MilestoneEntry[]>();

  for (const e of entries) {
    if (!e.ok) {
      errors.push(e);
      continue;
    }
    const list = byVersion.get(e.milestone);
    if (list === undefined) byVersion.set(e.milestone, [e]);
    else list.push(e);
  }

  const groups: MilestoneGroup[] = [];
  const versions = Array.from(byVersion.keys()).sort(compareVersions);

  for (const v of versions) {
    const parts = (byVersion.get(v) as MilestoneEntry[])
      .slice()
      .sort((a, b) => (a.part !== b.part ? a.part - b.part : a.file.localeCompare(b.file)));
    const head = parts[0];

    for (const p of parts.slice(1)) {
      for (const key of ['name', 'lifecycle', 'artifact_kind'] as const) {
        if (p[key] !== head[key]) {
          errors.push(
            err(
              p.file,
              'E_MILESTONE_GROUP_CONFLICT',
              `${key} disagrees within milestone ${v}: ${String(head[key])} vs ${String(p[key])}`,
            ),
          );
        }
      }
      if (p.shipped.join(',') !== head.shipped.join(',')) {
        errors.push(
          err(p.file, 'E_MILESTONE_GROUP_CONFLICT', `shipped disagrees within milestone ${v}`),
        );
      }
    }

    groups.push({
      milestone: v,
      name: head.name,
      lifecycle: head.lifecycle,
      shipped: head.shipped.slice(),
      artifact_kind: head.artifact_kind,
      parts,
      progress: parts.reduce(
        (acc, p) => ({ done: acc.done + p.progress.done, total: acc.total + p.progress.total }),
        { done: 0, total: 0 },
      ),
    });
  }

  const active = groups.filter((g) => g.lifecycle === 'active');
  if (active.length > 1) {
    errors.push(
      err(
        active.map((g) => g.milestone).join(', '),
        'E_MILESTONE_MULTIPLE_ACTIVE',
        `exactly one milestone may be lifecycle: active, found ${active.length}`,
      ),
    );
  }

  return { ok: errors.length === 0, groups, errors };
}

/**
 * Which `.planning` files are milestone artifacts.
 *
 * `MILESTONE-v*.md` ALWAYS is one: a missing frontmatter block is a loud failure, never
 * a skip. `BENCHMARK-v*.md` OPTS IN by carrying frontmatter, because most benchmark files
 * are reports ABOUT a milestone (BENCHMARK-v1.4-ANVIL.md documents milestone 1.4, which
 * already has its own MILESTONE artifact) rather than the artifact declaring one. Only
 * v1.5 and v1.7 have no MILESTONE file and use their benchmark doc as the artifact.
 *
 * Pure: the caller supplies `{name, text}` pairs; this never touches the disk.
 */
function selectArtifactFiles(files: Array<{ name: string; text: string }>): Array<{ name: string; text: string }> {
  return files.filter((f) => {
    if (/^MILESTONE-v\d/.test(f.name)) return true;
    if (/^BENCHMARK-v\d/.test(f.name)) return f.text.startsWith('---\n');
    return false;
  });
}

/** The single `lifecycle: active` group, or null. Phase 14.1 consumes this. */
function activeMilestone(groups: MilestoneGroup[]): MilestoneGroup | null {
  const active = groups.filter((g) => g.lifecycle === 'active');
  return active.length === 1 ? active[0] : null;
}

/** Render the committed `.planning/MILESTONES.md` body. Deterministic. */
function renderMilestonesIndex(groups: MilestoneGroup[]): string {
  const lines: string[] = [];
  lines.push('# Milestones: Ferrox Factory');
  lines.push('');
  lines.push('> GENERATED by `scripts/gen-milestones.cjs` from the `MILESTONE-v*.md` and');
  lines.push('> `BENCHMARK-v*.md` frontmatter. Do not edit by hand: `--check` runs inside');
  lines.push('> `lint:generated-sync`, so an edit here fails `lint:ci`. To change a row, edit the');
  lines.push('> artifact and run `node scripts/gen-milestones.cjs --write`.');
  lines.push('');
  lines.push('The milestone artifacts are the source of truth. This file is a projection of them.');
  lines.push('');
  lines.push('| Version | Name | Lifecycle | Kind | Shipped | Progress | Artifacts |');
  lines.push('|---|---|---|---|---|---|---|');

  for (const g of groups) {
    const shipped = g.shipped.length === 0 ? 'not published' : g.shipped.join(', ');
    const progress = g.progress.total === 0 ? 'n/a' : `${g.progress.done}/${g.progress.total}`;
    const files = g.parts.map((p) => `\`${p.file}\``).join('<br>');
    const life = g.lifecycle === 'active' ? '**active**' : g.lifecycle;
    lines.push(
      `| v${g.milestone} | ${g.name} | ${life} | ${g.artifact_kind} | ${shipped} | ${progress} | ${files} |`,
    );
  }

  lines.push('');
  lines.push('## Honest gaps');
  lines.push('');
  const unshipped = groups.filter((g) => g.shipped.length === 0).map((g) => `v${g.milestone}`);
  lines.push(
    unshipped.length === 0
      ? '- Every milestone recorded here has a published release.'
      : `- Never published to npm: ${unshipped.join(', ')}.`,
  );
  lines.push(
    '- Per-milestone start dates are not recorded. There is no hermetic local source for them',
  );
  lines.push('  (the repo carries no git tags), and a hand-transcribed date cannot be checked.');
  lines.push('- Version ordering, not dates, is what this index guarantees.');
  lines.push('');

  return lines.join('\n');
}

export = {
  parseMilestoneArtifact,
  selectArtifactFiles,
  collectMilestones,
  activeMilestone,
  renderMilestonesIndex,
  compareVersions,
  LIFECYCLES,
  KINDS,
};
