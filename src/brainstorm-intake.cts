/**
 * Brainstorm intake parser (v1.12 Wave 3, exit-as-intake seam).
 *
 * Downstream workflows (new-project, discuss-phase, new-milestone, plan-phase)
 * ingest `.planning/brainstorms/{slug}-{date}/BRAINSTORM.md` artifacts. The
 * promotion rule (brainstorm.md `<exit_gates>`) says the Decisions section may
 * only contain exit-confirmed items, each carrying provenance
 * `(stance: {guided|generative|sounding-board}, confirmed at exit)`. This
 * parser is the deterministic side of that contract: it reads the artifact
 * text and returns exactly what downstream may treat as OFF LIMITS
 * (decisions) versus freely askable (notes, open questions).
 *
 * FAIL-CLOSED on promotion: a Decisions bullet WITHOUT valid exit provenance
 * is never classified as a decision. It is demoted to the notes list (and
 * echoed in `demoted`), so an unconfirmed or hedged item can never silence a
 * downstream question. Hedged items already living in Notes stay notes.
 *
 * PURE: string in, object out. No fs, no process, never throws.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/brainstorm-intake.cjs. `export =` CJS shape; no stdout.
 */

interface BrainstormFrontmatter {
  template: string | null;
  status: string | null;
}

interface BrainstormDecision {
  text: string;
  stance: 'guided' | 'generative' | 'sounding-board';
  confirmedAtExit: true;
}

interface BrainstormIntake {
  frontmatter: BrainstormFrontmatter;
  decisions: BrainstormDecision[];
  notes: string[];
  openQuestions: string[];
  /** Decisions-section items that failed the provenance check (also in notes). */
  demoted: string[];
}

interface QuestionClassification {
  offLimits: Array<{ question: string; decision: string }>;
  askable: string[];
}

const PROVENANCE_RE =
  /\(stance:\s*(guided|generative|sounding-board)\s*,\s*confirmed at exit\)\s*\.?\s*$/i;

const PLACEHOLDER_RE = /^none\b/i;

const STOPWORDS = new Set([
  'about', 'been', 'could', 'does', 'doe', 'from', 'have', 'into', 'should',
  'that', 'their', 'them', 'there', 'they', 'this', 'were', 'what', 'when',
  'where', 'which', 'while', 'will', 'with', 'would', 'your',
]);

/**
 * Split a markdown body into `## `-heading sections, keyed lowercase.
 * Fence-aware: content inside ``` fences is inert (a fenced example decision
 * line must never be promoted, and a fenced heading must never open a phantom
 * section; cross-audit 2026-07-23 finding 2).
 */
function sectionize(body: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = [];
      sections.set(heading[1].toLowerCase(), current);
    } else if (current) {
      current.push(line);
    }
  }
  return sections;
}

/** Collect bullet or numbered list items from section lines; folds wrapped continuation lines. */
function listItems(lines: string[] | undefined): string[] {
  if (!lines) return [];
  const items: string[] = [];
  for (const rawLine of lines) {
    // trimEnd() before matching: a bullet marker followed by a long trailing
    // whitespace run forced quadratic backtracking between \s+ and (.*\S)
    // (measured 15s at 200k spaces; cross-audit 2026-07-23 finding 1).
    const line = rawLine.trimEnd();
    const bullet = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)$/.exec(line);
    if (bullet) {
      items.push(bullet[1]);
    } else if (items.length > 0 && /^\s+\S/.test(line)) {
      items[items.length - 1] += ' ' + line.trim();
    }
  }
  return items.filter((item) => !PLACEHOLDER_RE.test(item));
}

function parseFrontmatter(text: string): { frontmatter: BrainstormFrontmatter; body: string } {
  const frontmatter: BrainstormFrontmatter = { template: null, status: null };
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { frontmatter, body: text };
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (key === 'template') frontmatter.template = kv[2] || null;
    if (key === 'status') frontmatter.status = kv[2] || null;
  }
  return { frontmatter, body: text.slice(match[0].length) };
}

/**
 * Parse a BRAINSTORM.md artifact into its intake shape.
 * Non-string input yields the empty intake (never throws).
 */
function parseBrainstormArtifact(markdown?: unknown): BrainstormIntake {
  const empty: BrainstormIntake = {
    frontmatter: { template: null, status: null },
    decisions: [],
    notes: [],
    openQuestions: [],
    demoted: [],
  };
  if (typeof markdown !== 'string' || markdown.length === 0) return empty;

  const { frontmatter, body } = parseFrontmatter(markdown);
  const sections = sectionize(body);

  const decisions: BrainstormDecision[] = [];
  const demoted: string[] = [];
  for (const item of listItems(sections.get('decisions'))) {
    const prov = PROVENANCE_RE.exec(item);
    if (prov) {
      decisions.push({
        text: item.replace(PROVENANCE_RE, '').trim(),
        stance: prov[1].toLowerCase() as BrainstormDecision['stance'],
        confirmedAtExit: true,
      });
    } else {
      demoted.push(item);
    }
  }

  const notes = [...listItems(sections.get('notes')), ...demoted];
  const openQuestions = listItems(sections.get('open questions'));

  return { frontmatter, decisions, notes, openQuestions, demoted };
}

/** Normalize text to a set of significant tokens (4+ chars, plural-stripped, no stopwords). */
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const word = raw.replace(/s$/, '');
    if (word.length >= 4 && !STOPWORDS.has(word)) out.add(word);
  }
  return out;
}

/**
 * Classify candidate questions against exit-confirmed decisions. A question
 * is OFF LIMITS when it substantially restates a decision: its significant
 * tokens cover at least half of the decision's tokens (minimum 2). Grazing a
 * decision with 1 or 2 shared words (a compound term, a common noun) stays
 * askable. Deterministic: token overlap only, no vibes.
 */
function classifyQuestions(
  decisions?: unknown,
  questions?: unknown
): QuestionClassification {
  const result: QuestionClassification = { offLimits: [], askable: [] };
  if (!Array.isArray(questions)) return result;
  const decisionTexts: string[] = Array.isArray(decisions)
    ? decisions
        .map((d: unknown) =>
          typeof d === 'string'
            ? d
            : d && typeof (d as { text?: unknown }).text === 'string'
              ? (d as { text: string }).text
              : ''
        )
        .filter((t) => t.length > 0)
    : [];
  const decisionTokens = decisionTexts.map((t) => tokens(t));

  for (const q of questions) {
    if (typeof q !== 'string') continue;
    const qTokens = tokens(q);
    let matched: string | null = null;
    for (let i = 0; i < decisionTokens.length && matched === null; i++) {
      const required = Math.max(2, Math.ceil(decisionTokens[i].size / 2));
      let overlap = 0;
      for (const word of qTokens) {
        if (decisionTokens[i].has(word)) overlap++;
        if (overlap >= required) {
          matched = decisionTexts[i];
          break;
        }
      }
    }
    if (matched !== null) result.offLimits.push({ question: q, decision: matched });
    else result.askable.push(q);
  }
  return result;
}

export = { parseBrainstormArtifact, classifyQuestions };
