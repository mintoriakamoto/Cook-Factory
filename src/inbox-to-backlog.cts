/**
 * inbox.to-backlog core (TRIAGE-01, v1.1 Phase C).
 *
 * Turns a triaged, APPROVED GitHub issue into a Ferrox backlog row. This is the
 * seam that connects `ferrox-inbox` (triage/report) to the Build Line (backlog →
 * plan → execute).
 *
 * The issue-first GATE is enforced here, not in prose: an issue is only routed to
 * the backlog if it carries its approval label
 * (feature→approved-feature, enhancement→approved-enhancement, bug→confirmed-bug).
 * An ungated issue is REFUSED — CONTRIBUTING.md's "no PR without approval" rule
 * begins at backlog entry, so un-approved work never enters the line.
 *
 * PURE: no I/O. The caller (inbox workflow) supplies the parsed issue and writes
 * the returned row to .planning/BACKLOG.md. `export =` CJS shape.
 */

type IssueType = 'feature' | 'enhancement' | 'bug' | 'chore';

interface IssueInput {
  number: number;
  title: string;
  type: IssueType;
  labels: string[];
  /** Testable conditions parsed from the issue's Acceptance criteria field. */
  acceptanceCriteria?: string;
}

interface RefusedResult {
  decision: 'refused-not-gated';
  reason: string;
  /** The approval label the issue is missing. */
  requiredLabel: string;
}

interface AppendResult {
  decision: 'append';
  /** The backlog ID: gh-sourced so provenance is unambiguous. */
  id: string;
  /** Formatted BACKLOG.md "Open" table row (pipe-delimited, no leading/trailing pipe trimming). */
  row: string;
  source: string;
}

type ToBacklogResult = RefusedResult | AppendResult;

/** The approval label each issue type must carry to enter the line. */
const APPROVAL_LABEL: Record<IssueType, string> = {
  feature: 'approved-feature',
  enhancement: 'approved-enhancement',
  bug: 'confirmed-bug',
  chore: 'approved-chore',
};

/** Severity seed by type; the independent judge may re-grade later (STRONG-01). */
const TYPE_SEV: Record<IssueType, string> = {
  feature: 'FEAT',
  enhancement: 'ENH',
  bug: 'BUG',
  chore: 'LOW',
};

function normLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map((l) => String(l).trim().toLowerCase()).filter((l) => l.length > 0);
}

function sanitizeCell(s: string): string {
  // BACKLOG.md rows are a markdown table — a literal pipe would break the column.
  // Escape backslashes FIRST, else a title like `x\|y` -> `x\\|y` leaves the pipe
  // as a live GFM delimiter (Phase-C cross-audit MEDIUM). Order matters.
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * PURE. Decide whether an approved issue becomes a backlog row.
 */
function evaluateToBacklog(issue: IssueInput): ToBacklogResult {
  const type = issue.type;
  const required = APPROVAL_LABEL[type];
  if (!required) {
    return { decision: 'refused-not-gated', reason: `unknown issue type '${type}'`, requiredLabel: '' };
  }
  const labels = normLabels(issue.labels);
  if (!labels.includes(required)) {
    return {
      decision: 'refused-not-gated',
      reason: `issue #${issue.number} lacks the ${required} approval label — issue-first gate (CONTRIBUTING.md)`,
      requiredLabel: required,
    };
  }

  const source = `gh#${issue.number}`;
  const id = `gh-${issue.number}`;
  const ac = (issue.acceptanceCriteria || '').trim();
  const acFragment = ac.length > 0 ? ` Acceptance: ${ac}` : '';
  const item = sanitizeCell(`[${source}] ${issue.title}.${acFragment}`);
  const row = `| ${id} | ${TYPE_SEV[type]} | inbox (${source}) | ${item} | — |`;

  return { decision: 'append', id, row, source };
}

export = { evaluateToBacklog, APPROVAL_LABEL, TYPE_SEV };
