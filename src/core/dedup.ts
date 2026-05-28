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
  'i', 'ii', 'iii', 'iv', 'jr', 'sr',
  // Work-mode noise — hyphenated compounds get split by the tokenizer,
  // so list the constituent words rather than the hyphenated form.
  'remote', 'hybrid', 'onsite', 'full', 'part', 'time', 'fulltime', 'parttime',
]);

export function roleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[(),/]/g, ' ')
      .split(/[^a-z0-9+#.]+/)
      .filter(t => t.length > 1 && !ROLE_STOPWORDS.has(t)),
  );
}

// Two titles are "the same role" if Jaccard similarity over their token sets
// is ≥ 0.7, OR if the smaller token set is fully contained in the larger
// (e.g. "Senior Engineer" vs "Senior Engineer (Backend)").
export function rolesMatch(a: string, b: string): boolean {
  const ta = roleTokens(a);
  const tb = roleTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;

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
