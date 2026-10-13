import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { termMatches } from '../core/filter';
import { placesIn } from '../core/geo';
import { htmlToText, toMillis, sleep } from './aggregator-util';

// Keyless Algolia HN API. One search finds the monthly "Who is hiring?" threads,
// then one `items/{id}` request per thread returns the whole comment tree
// (~0.5MB, ~250-700 top-level postings), so a scan costs ~3 requests.
const HN_ALLOWED_HOSTS = ['hn.algolia.com'];
const THREAD_SEARCH_URL =
  'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10';
const THREADS = 2;
const REQUEST_DELAY_MS = 500;
const TITLE_MAX = 200;
const COMPANY_MAX = 100;
const LOCATION_MAX = 200;

// The same account posts "Who wants to be hired?" and "Freelancer?" threads.
const HIRING_TITLE_RX = /^Ask HN: Who is hiring\?/i;

const ROLE_RX =
  /\b(engineers?|engineering|developers?|swe|sde|sre|devops|designers?|managers?|scientists?|analysts?|architects?|leads?|directors?|heads? of|founding|researchers?|programmers?|consultants?|recruiters?|specialists?|administrators?|officers?|cto|vp|devrel|advocates?|writers?|marketers?|sales|accountants?|technicians?|roles?|positions?|openings|full[- ]?stack|front[- ]?end|back[- ]?end)\b/i;
const EMPLOYMENT_RX =
  /^(full[- ]?time|part[- ]?time|contract|contractor|freelance|interns?|internships?|permanent|perm|temporary|temp|b2b|fixed[- ]term|employment)\b/i;
const MONEY_RX = /[$€£]\s?\d|\d\s?[kK]\b|\bequity\b|\bsalary\b|\bcompetitive\b/i;
const WORKPLACE_RX = /\b(remote|onsite|on-site|hybrid|in[- ]person|worldwide|time ?zones?)\b/i;
const ONSITE_RX = /\b(onsite|on-site|hybrid|in[- ]person)\b/i;
const NEG_REMOTE_RX = /\b(?:no|not|non)[\s-]+remote\b/i;
// A segment that opens with an amount ("$130-240K+ (depending on role)") is pay,
// even when its prose happens to contain a role word.
const LEADING_MONEY_RX = /^[$€£]\s?\d/;
const URL_RX = /(?:https?:\/\/|www\.)\S+/gi;

const CUR = String.raw`(?:US|CA|C|AU|A|NZ|S)?[$€£]`;
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?`;
const SALARY_RANGE_RX = new RegExp(
  String.raw`(?<![\w$€£.])(?:(?<p1>${CUR})\s?)?(?<a>${AMOUNT})\s?(?<ka>[kK])?\s?(?:-|–|—|to)\s?(?:(?<p2>${CUR})\s?)?(?<b>${AMOUNT})\s?(?<kb>[kK])?(?<s>[$€£])?(?:\s?(?<code>USD|EUR|GBP|CAD|AUD|CHF|SEK|NOK|DKK|NZD|SGD|PLN)\b)?`,
  'g',
);
// A range quoted per hour/day/month is not an annual salary.
const NON_ANNUAL_RX = /^\s*(?:\/|per\s|an?\s)?\s*(?:h(?:ou)?rs?\b|hourly|day|week|wk\b|month|mo\b|mth)/i;

const SYMBOL_CURRENCY: Record<string, string> = {
  '$': 'USD', 'US$': 'USD', 'CA$': 'CAD', 'C$': 'CAD', 'AU$': 'AUD', 'A$': 'AUD',
  'NZ$': 'NZD', 'S$': 'SGD', '€': 'EUR', '£': 'GBP',
};

export interface HnSalary {
  min: number;
  max: number;
  currency: string;
}

/**
 * Extract an unambiguous annual salary range from a posting's header line:
 * a two-number range with a currency symbol or ISO code ("$150k-$190k",
 * "€75k–80k", "100k-160k GBP", "$130-240K+"). Single figures, ranges without a
 * currency, per-hour/day/month rates and implausible magnitudes yield null — the
 * header is free text, so a wrong salary is worse than none (JD-based extraction
 * is a later phase).
 */
export function parseHnSalary(line: string): HnSalary | null {
  for (const m of line.matchAll(SALARY_RANGE_RX)) {
    const g = m.groups!;
    const after = line.slice((m.index ?? 0) + m[0].length);
    if (NON_ANNUAL_RX.test(after)) continue;

    const symbol = g['p1'] ?? g['p2'] ?? g['s'];
    const currency = g['code'] ?? (symbol ? SYMBOL_CURRENCY[symbol] : undefined);
    if (!currency) continue;

    let a = parseFloat(g['a']!.replace(/,/g, ''));
    let b = parseFloat(g['b']!.replace(/,/g, ''));
    const anyK = !!(g['ka'] || g['kb']);
    // "$130-240K": one trailing k scales the bare side too, as long as it's small.
    if (g['ka'] || (anyK && a < 1000)) a *= 1000;
    if (g['kb'] || (anyK && b < 1000)) b *= 1000;
    a = Math.round(a);
    b = Math.round(b);
    if (a < 10_000 || b > 10_000_000 || a > b) continue;
    return { min: a, max: b, currency };
  }
  return null;
}

function clean(s: string, max: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Split top-level commas outside parentheses. */
function splitTopLevel(seg: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of seg) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

/** A role segment can carry its location ("Senior Backend Engineer, Remote (US)"):
 *  workplace-only comma parts move to location and the title keeps just the role. */
function splitRoleSegment(seg: string): { role: string; workplace: string[] } {
  const keep: string[] = [];
  const workplace: string[] = [];
  for (const part of splitTopLevel(seg)) {
    if (WORKPLACE_RX.test(part) && !ROLE_RX.test(part)) workplace.push(part);
    else keep.push(part);
  }
  return keep.length > 0 ? { role: keep.join(', '), workplace } : { role: seg, workplace: [] };
}

function isUrlOnly(seg: string): boolean {
  return /^(?:https?:\/\/|www\.)/i.test(seg) || /^[^\s/]+\.[a-z]{2,}(?:\/\S*)?$/i.test(seg);
}

export interface HnHeader {
  company: string;
  /** Role segments joined, '' when the header names none. */
  role: string;
  location: string;
  remote: boolean | undefined;
  salary: HnSalary | null;
}

/**
 * Parse the pipe-separated first line of a "Who is hiring?" comment
 * (`Company | Role(s) | Location | Full-time | $150k-$190k | url`). Segment order
 * is only a convention, so each non-company segment is classified: role words →
 * role, remote/onsite/hybrid or a gazetteer place → location, URL / employment
 * type / money → ignored, and if no segment looked like a role the first leftover
 * segment stands in. Returns null when the line doesn't follow the convention
 * (no `|`) or has no usable company.
 */
export function parseHnHeader(line: string): HnHeader | null {
  if (!line.includes('|')) return null;
  const segs = line.split('|').map(s => s.trim()).filter(Boolean);
  if (segs.length < 2) return null;

  const company = clean(
    segs[0]!
      .replace(/\(\s*(?:https?:\/\/|www\.)[^)]*\)/gi, ' ')
      .replace(URL_RX, ' ')
      .replace(/\(\s*\)/g, ' ')
      // "Acme (YC W21)" -> "Acme" so company_norm lines up with ATS rows.
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, ''),
    COMPANY_MAX,
  );
  if (!company) return null;

  const roles: string[] = [];
  const locations: string[] = [];
  const leftovers: string[] = [];
  for (const seg of segs.slice(1)) {
    if (isUrlOnly(seg) || LEADING_MONEY_RX.test(seg)) continue;
    if (ROLE_RX.test(seg)) {
      const { role, workplace } = splitRoleSegment(seg);
      roles.push(role);
      locations.push(...workplace);
    }
    else if (WORKPLACE_RX.test(seg)) locations.push(seg);
    else if (EMPLOYMENT_RX.test(seg) || MONEY_RX.test(seg)) continue;
    else if (placesIn(seg).size > 0) locations.push(seg);
    else leftovers.push(seg);
  }
  // Decorative segments ("√ PMF") start with a symbol, real role text with a letter.
  const fallback = leftovers.find(l => /^[\p{L}\p{N}]/u.test(l));
  if (roles.length === 0 && fallback) roles.push(fallback);

  const rest = segs.slice(1).join(' | ');
  const remote = /\bremote\b/i.test(rest) && !NEG_REMOTE_RX.test(rest)
    ? true
    : ONSITE_RX.test(rest) ? false : undefined;

  return {
    company,
    role: clean(roles.join(', '), TITLE_MAX),
    location: clean(locations.join('; '), LOCATION_MAX),
    remote,
    salary: parseHnSalary(line),
  };
}

/** First non-empty line of the comment's first paragraph, as plain text. */
function firstLine(html: string): string {
  const para = html.split(/<p>/i).map(s => s.trim()).find(Boolean) ?? '';
  return htmlToText(para).split('\n').find(l => l.trim()) ?? '';
}

/**
 * Turn one top-level comment into a Job, or null when it isn't a usable posting
 * (deleted/empty, header not in the pipe convention, or no keyword match).
 *
 * Admission is a recall-oriented keyword gate, since HN headers are terse
 * ("Acme | Engineers | Remote"): the parsed role or, failing that, the full
 * comment text must whole-word match a keyword. The title is always the parsed
 * role as written (never rewritten with the keyword — that would fabricate text,
 * change the content hash per query and defeat dedup), so L1's title gate still
 * drops body-only matches (semantic rescue in runner/semantic-rescue.ts can recover them).
 */
export function parseHnComment(c: unknown, keywords: string[]): Job | null {
  const r = c as Record<string, unknown>;
  const html = typeof r['text'] === 'string' ? r['text'] : '';
  const id = typeof r['id'] === 'number' ? r['id'] : Number(r['id']);
  if (!html.trim() || !Number.isInteger(id) || id <= 0) return null;

  const header = parseHnHeader(firstLine(html));
  if (!header) return null;

  const jd = htmlToText(html);
  if (!keywords.some(k => termMatches(jd, k))) return null;
  const title = header.role || 'Open roles';

  return {
    external_id: String(id),
    title,
    url: `https://news.ycombinator.com/item?id=${id}`,
    company: header.company,
    location: header.location,
    remote: header.remote,
    salary_min_usd: header.salary?.min ?? null,
    salary_max_usd: header.salary?.max ?? null,
    salary_currency: header.salary?.currency ?? null,
    posted_at: toMillis(r['created_at_i']) ?? toMillis(r['created_at']),
    jd_text: jd || undefined,
  };
}

/** Top-level comments of an `items/{id}` tree only — replies are not postings. */
export function parseHnThread(json: unknown, keywords: string[]): Job[] {
  const children = (json as { children?: unknown })?.children;
  if (!Array.isArray(children) || keywords.length === 0) return [];
  const jobs: Job[] = [];
  for (const c of children) {
    const job = parseHnComment(c, keywords);
    if (job) jobs.push(job);
  }
  return jobs;
}

/** Ids of the newest "Who is hiring?" stories from a `search_by_date` response. */
export function parseHnThreadIds(json: unknown, limit = THREADS): string[] {
  const hits = (json as { hits?: unknown })?.hits;
  if (!Array.isArray(hits)) return [];
  const ids: string[] = [];
  for (const h of hits) {
    const r = h as Record<string, unknown>;
    const id = String(r['objectID'] ?? '');
    // Numeric-only: the id is interpolated into a request path.
    if (typeof r['title'] === 'string' && HIRING_TITLE_RX.test(r['title']) && /^\d+$/.test(id)) ids.push(id);
  }
  return ids.slice(0, limit);
}

export class HnHiringAdapter implements SourceAdapter {
  type = 'hn_hiring' as const;
  jdSalaryUnreliable = true;

  constructor(private readonly requestDelayMs: number = REQUEST_DELAY_MS) {}

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const keywords = ctx.keywords ?? [];
    if (keywords.length === 0) {
      ctx.emitProgress('HN Who is hiring: no title keyword set — skipping');
      return;
    }
    ctx.emitProgress(`Fetching HN "Who is hiring?" for ${keywords.join(', ')}…`);
    const opts = { allowedHosts: HN_ALLOWED_HOSTS, timeoutMs: 30_000, retries: 2 };

    const ids = parseHnThreadIds(await fetchJson(THREAD_SEARCH_URL, opts));
    if (ids.length === 0) {
      ctx.emitProgress('HN Who is hiring: no hiring thread found');
      return;
    }

    const seen = new Set<string>();
    let total = 0;
    let failures = 0;
    for (const [i, id] of ids.entries()) {
      if (ctx.abortSignal.aborted) return;
      await sleep(this.requestDelayMs);
      if (ctx.abortSignal.aborted) return;

      let json: unknown;
      try {
        json = await fetchJson(`https://hn.algolia.com/api/v1/items/${id}`, opts);
      } catch {
        failures++;
        ctx.emitProgress(`HN Who is hiring: thread ${i + 1} request failed`);
        continue;
      }
      for (const job of parseHnThread(json, keywords)) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        total++;
        yield job;
      }
    }

    if (failures === ids.length) throw new Error('HN Who is hiring: all thread requests failed');
    ctx.emitProgress(`HN Who is hiring: ${total} jobs`, total);
  }
}
