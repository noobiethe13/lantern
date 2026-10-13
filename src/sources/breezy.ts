import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';
import { htmlToText, toMillis } from './aggregator-util';

// Breezy HR publishes a tenant's open positions at `https://{slug}.breezy.hr/json`.
// Adding `?verbose=true` inlines each position's HTML `description`, so one
// request returns everything (no per-job detail fetches).

type Obj = Record<string, unknown>;

const CURRENCY_SYMBOLS: Record<string, string> = { '£': 'GBP', '€': 'EUR', '₹': 'INR' };
const SALARY_RX =
  /^\s*([£€₹$]|[A-Z]{3})\s?([\d.,]+)\s?(k?)\s*(?:[–—-]\s*(?:[£€₹$]|[A-Z]{3})?\s?([\d.,]+)\s?(k?))?\s*(\+?)\s*\/\s*(?:year|yr|annum|annual|yearly)\b/i;
// Postings are free text typed by the employer ("$14 – $16 / year" occurs); an
// annual figure under this is a unit mistake, not a salary.
const MIN_PLAUSIBLE_ANNUAL = 1_000;

/** "50,000", "50.000" (European thousands) or "52.5" → number, or null. */
function parseAmount(raw: string, kilo: boolean): number | null {
  const s = /^\d{1,3}(\.\d{3})+$/.test(raw) ? raw.replace(/\./g, '') : raw.replace(/,/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(kilo ? n * 1000 : n);
}

/**
 * Map Breezy's free-text `salary` ("$55,000 – $60,000 / year") to a native-
 * currency range. Only an explicitly yearly figure with a currency marker is
 * taken; hourly/daily/unitless text and implausibly small annual figures are
 * left unmapped. A bare `$` is ambiguous (USD/CAD/AUD/…), so it maps to USD
 * only when the caller says every location of the posting is in the US
 * (`usOnly`) — otherwise the amount is dropped rather than mislabeled.
 * `$X+ / year` yields a floor with no ceiling.
 */
export function parseBreezySalary(
  raw: unknown,
  usOnly = false,
): { salary_min_usd: number; salary_max_usd: number | null; salary_currency: string } | null {
  if (typeof raw !== 'string') return null;
  const m = raw.match(SALARY_RX);
  if (!m) return null;
  if (m[1] === '$' && !usOnly) return null;
  const currency = m[1] === '$' ? 'USD' : (CURRENCY_SYMBOLS[m[1]] ?? m[1].toUpperCase());
  const min = parseAmount(m[2], m[3].toLowerCase() === 'k');
  const max = m[4] ? parseAmount(m[4], (m[5] ?? '').toLowerCase() === 'k') : null;
  if (min === null || min < MIN_PLAUSIBLE_ANNUAL) return null;
  if (max !== null && max < min) return null;
  const openEnded = m[6] === '+';
  return { salary_min_usd: min, salary_max_usd: openEnded ? null : (max ?? min), salary_currency: currency };
}

/** A location is remote unless Breezy flags it hybrid; `remote*` detail values
 *  count even when `is_remote` is unset. */
function isRemoteLocation(loc: Obj): boolean {
  const kind = (loc['remote_details'] as Obj | undefined)?.['value'];
  if (kind === 'hybrid') return false;
  if (typeof kind === 'string' && kind.startsWith('remote')) return true;
  return loc['is_remote'] === true;
}

/**
 * Map the `/json?verbose=true` position array. Location joins every distinct
 * `locations[].name` (falling back to the single `location`); a position is
 * remote when any of its locations is. The posting link must be on the tenant
 * host or it is rebuilt from `friendly_id`. Positions with no name or no usable
 * link are dropped.
 */
export function parseBreezy(json: unknown, company: string, host: string): Job[] {
  if (!Array.isArray(json)) return [];

  const jobs: Job[] = [];
  for (const raw of json) {
    const p = raw as Obj;
    const title = typeof p['name'] === 'string' ? p['name'].trim() : '';
    const id = typeof p['id'] === 'string' ? p['id'] : '';
    const friendlyId = typeof p['friendly_id'] === 'string' ? p['friendly_id'] : id;
    const url = onHostUrl(p['url'], host, friendlyId);
    if (!title || !url) continue;

    const locs = [
      ...(Array.isArray(p['locations']) ? (p['locations'] as Obj[]) : []),
      ...(p['location'] && typeof p['location'] === 'object' ? [p['location'] as Obj] : []),
    ];
    const names = [...new Set(locs.map(l => (typeof l['name'] === 'string' ? l['name'].trim() : '')).filter(Boolean))];
    const remote = locs.some(isRemoteLocation);
    if (remote && !names.some(n => /remote/i.test(n))) names.push('Remote');

    const jd = htmlToText(typeof p['description'] === 'string' ? p['description'] : '');
    const usOnly = locs.length > 0 && locs.every(l => (l['country'] as Obj | undefined)?.['id'] === 'US');
    const salary = parseBreezySalary(p['salary'], usOnly);

    jobs.push({
      external_id: id || friendlyId,
      title,
      url,
      company,
      location: names.join('; '),
      remote,
      posted_at: toMillis(p['published_date']),
      jd_text: jd || undefined,
      ...(salary ?? {}),
    });
  }
  return jobs;
}

function onHostUrl(raw: unknown, host: string, friendlyId: string): string {
  if (typeof raw === 'string') {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'https:' && parsed.hostname === host) return parsed.href;
    } catch {
      // malformed → rebuilt below
    }
  }
  return friendlyId ? `https://${host}/p/${encodeURIComponent(friendlyId)}` : '';
}

export class BreezyAdapter implements SourceAdapter {
  type = 'breezy' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as { identifier: string; display_name: string };
    assertValidSlug(identifier, 'Breezy subdomain slug');
    const host = `${identifier}.breezy.hr`;
    ctx.emitProgress(`Fetching ${display_name} (Breezy)…`);

    const json = await fetchJson(`https://${host}/json?verbose=true`, { allowedHosts: [host], retries: 2, signal: ctx.abortSignal });
    const jobs = parseBreezy(json, display_name, host);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
