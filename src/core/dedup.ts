import type { Job } from './job';
import { sha256hex } from './hash';

export function contentHash(job: Job): string {
  const parts = [
    job.title,
    job.location ?? '',
    job.jd_text ?? '',
  ];
  return sha256hex(parts.join('|'));
}

// Normalize a company name for fuzzy dedup. The same job often appears under
// "Stripe", "Stripe Inc", "Stripe, Inc.", "Stripe.com" across boards — we want
// all of those to collide on the same key.
const COMPANY_SUFFIX_RE =
  /\b(inc|incorporated|ltd|limited|llc|corp|corporation|co|company|gmbh|sa|sas|pvt|pte|ag|plc|holdings|group|labs)\b/g;

export function normalizeCompany(s: string): string {
  return s
    .toLowerCase()
    .replace(/[,.’'"]/g, '')
    .replace(COMPANY_SUFFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Generic stopwords + role-fluff words that don't carry signal.
const ROLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'at', 'to', 'in', 'on',
  'with', 'our', 'your', 'their', 'from', 'into',
  // Work-mode noise — hyphenated compounds get split by the tokenizer,
  // so list the constituent words rather than the hyphenated form.
  'remote', 'hybrid', 'onsite', 'full', 'part', 'time', 'fulltime', 'parttime',
]);

// Level/seniority words are the opposite of stopwords: "Senior Engineer" and
// "Engineer" are DIFFERENT roles, so these must survive tokenization and are
// later required to match exactly between two titles (see rolesMatch) rather
// than being dropped or allowed to slide through the subset rule. Covers
// common abbreviations (sr/snr/jr) and ladder numerals — both roman (SDE II)
// and arabic (SDE 2) — used by leveled engineering titles. Bare digits are
// intentionally always treated as level tokens (no attempt to detect "is this
// an SDE-style title") — worst case that's an occasional false split (two rows
// for the same job), which is far cheaper than the false merge a laxer rule
// risks (silently hiding a distinct opening).
const LEVEL_TOKENS = new Set([
  'senior', 'sr', 'snr', 'staff', 'principal', 'lead',
  'junior', 'jr', 'intern', 'associate', 'entry', 'graduate',
  'i', 'ii', 'iii', 'iv', '1', '2', '3', '4',
]);

export function roleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[(),/]/g, ' ')
      .split(/[^a-z0-9+#.]+/)
      // Fold a trailing abbreviation dot ("sr." -> "sr") so "Sr." and "Sr" tokenize
      // identically; leaves internal/leading dots ("node.js", ".net") untouched.
      .map(t => t.replace(/\.$/, ''))
      // Single-char tokens are normally noise, EXCEPT a level token ("i" / a bare
      // ladder digit) — those must survive to feed the level-token check below.
      .filter(t => (t.length > 1 || LEVEL_TOKENS.has(t)) && !ROLE_STOPWORDS.has(t)),
  );
}

function levelTokens(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) if (LEVEL_TOKENS.has(t)) out.add(t);
  return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

// Two titles are "the same role" if Jaccard similarity over their token sets
// is ≥ 0.7, OR if the smaller token set is fully contained in the larger
// (e.g. "Senior Engineer" vs "Senior Engineer (Backend)") — but ONLY when both
// sides carry the exact same level tokens (including "none stated"). Without
// that gate the subset rule would happily swallow an extra "Senior"/"III" on
// one side as if it were harmless title noise (e.g. "Senior Software Engineer"
// vs "Software Engineer" — those are different postings, not a rewording).
export function rolesMatch(a: string, b: string): boolean {
  const ta = roleTokens(a);
  const tb = roleTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  if (!setsEqual(levelTokens(ta), levelTokens(tb))) return false;

  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  if (inter / union >= 0.7) return true;

  const smaller = ta.size < tb.size ? ta : tb;
  const larger = ta.size < tb.size ? tb : ta;
  if (smaller.size < 2) return false;
  for (const t of smaller) {
    if (!larger.has(t)) return false;
  }
  return true;
}

function normalizeLocation(loc: string | null | undefined): string {
  return (loc ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Should an incoming posting fold into an existing DB row as the same job?
 * True when the titles are the same role (rolesMatch, including the level-token
 * gate above) AND the locations are compatible — normalized-equal, or either
 * side is empty/unset (so postings with an unknown location don't get stranded
 * as spurious "distinct" rows). Location is deliberately kept OUT of rolesMatch
 * itself (a pure title comparison with other callers/tests) and layered on here
 * instead, since fuzzy-dedup identity is "same role, same place" while a title
 * comparison alone is not.
 *
 * Needs from scan.ts: findFuzzyDuplicate should call this (in place of a bare
 * rolesMatch check) to decide whether to fold an incoming job into an existing
 * row — so "Senior X" no longer collapses into "X", and "X in London" no longer
 * collapses into "X in Berlin". On a fold, set the row's l1_pass to
 * MAX(existing.l1_pass, incoming.l1_pass) (not just left untouched at the
 * existing row's old value) so an L1-passing posting is never silently dropped
 * just because a same-role duplicate that failed L1 happened to be inserted
 * first.
 */
export function shouldFold(
  existing: { title: string; location?: string | null },
  incoming: { title: string; location?: string | null },
): boolean {
  if (!rolesMatch(existing.title, incoming.title)) return false;
  const locA = normalizeLocation(existing.location);
  const locB = normalizeLocation(incoming.location);
  if (!locA || !locB) return true;
  return locA === locB;
}
