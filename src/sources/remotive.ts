import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { htmlToText, toMillis, sleep } from './aggregator-util';
import { pickKeywords } from './gated-util';

// Remotive's API terms (shipped in every response): max ~4 calls/day, requests
// faster than ~2/min are blocked, and jobs must link back to Remotive and name it
// as the source. Job URLs are Remotive's own and the source is labelled
// "Remotive" in the roster. Hence: opt-in (seeded disabled), at most
// MAX_KEYWORDS requests per scan, spaced REQUEST_GAP_MS apart, and a rolling
// 24h call budget and request spacing persisted across scans and shared by every
// Remotive row.
const REMOTIVE_ALLOWED_HOSTS = ['remotive.com'];
const REMOTIVE_URL = 'https://remotive.com/api/remote-jobs';
const MAX_KEYWORDS = 2;
const DAILY_CALL_BUDGET = 4;
const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
const REQUEST_GAP_MS = 31_000;

export type ReserveResult =
  | { status: 'ok' }
  | { status: 'wait'; waitMs: number }
  | { status: 'exhausted' };

/**
 * Atomic claim of one Remotive call. Implementations must do read-prune-check-
 * append-save with no await in between: concurrent Remotive rows in one scan
 * would otherwise each read the same budget and overspend it.
 */
export interface RemotiveBudgetStore {
  reserve(now: number, gapMs: number): ReserveResult;
}

/**
 * Pure core of a reservation. `timestamps` are prior call times (epoch ms). On
 * `ok` the returned list has `now` appended and old entries pruned; otherwise it
 * is unchanged. A call inside `gapMs` of the newest recorded one must wait, so
 * the ">2 req/min" rule holds across scans and across concurrent rows too.
 */
export function reserveCall(
  timestamps: number[],
  now: number,
  gapMs: number,
): { result: ReserveResult; timestamps: number[] } {
  const recent = timestamps.filter(t => now - t < BUDGET_WINDOW_MS);
  if (recent.length >= DAILY_CALL_BUDGET) return { result: { status: 'exhausted' }, timestamps: recent };
  const newest = recent.length > 0 ? Math.max(...recent) : -Infinity;
  if (now - newest < gapMs) return { result: { status: 'wait', waitMs: gapMs - (now - newest) }, timestamps: recent };
  return { result: { status: 'ok' }, timestamps: [...recent, now] };
}

function buildUrl(keyword: string): string {
  return `${REMOTIVE_URL}?search=${encodeURIComponent(keyword)}`;
}

/** Remotive timestamps are UTC but carry no zone suffix, which `Date.parse`
 *  would read as local time. */
function remotiveMillis(value: unknown): number | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(value)) return toMillis(`${value}Z`);
  return toMillis(value);
}

/**
 * Parse a Remotive `/api/remote-jobs` response. Jobs live under `jobs`; `url` is
 * the Remotive listing page (the attribution link-back) and
 * `candidate_required_location` is the region the candidate must be in
 * ("Worldwide", "USA Only", …). Every posting is remote. `salary` is free text
 * ("OTE $25k - $35k") with no period or reliable currency, so it is not mapped.
 */
export function parseRemotive(json: unknown): Job[] {
  const items = (json as { jobs?: unknown[] })?.jobs;
  if (!Array.isArray(items)) return [];

  const jobs: Job[] = [];
  for (const it of items) {
    const j = it as Record<string, unknown>;
    const title = typeof j['title'] === 'string' ? j['title'].trim() : '';
    const url = typeof j['url'] === 'string' ? j['url'] : '';
    const company = typeof j['company_name'] === 'string' ? j['company_name'].trim() : '';
    if (!title || !url || !company) continue;

    jobs.push({
      external_id: String(j['id'] ?? ''),
      title,
      url,
      company,
      location: typeof j['candidate_required_location'] === 'string' ? j['candidate_required_location'].trim() : '',
      remote: true,
      posted_at: remotiveMillis(j['publication_date']),
      jd_text: htmlToText(j['description'] as string) || undefined,
    });
  }
  return jobs;
}

export class RemotiveAdapter implements SourceAdapter {
  type = 'remotive' as const;

  /** `store` defaults to the settings-KV ledger, loaded lazily so parse-only
   *  tests never open the real DB. */
  constructor(
    private readonly store?: RemotiveBudgetStore,
    private readonly gapMs: number = REQUEST_GAP_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const keywords = pickKeywords(ctx, MAX_KEYWORDS);
    if (keywords.length === 0) {
      ctx.emitProgress('Remotive: no title keyword set — skipping');
      return;
    }
    const store = this.store ?? (await import('./remotive-budget')).settingsBudgetStore;
    ctx.emitProgress(`Fetching Remotive for ${keywords.join(', ')}…`);

    const seen = new Set<string>();
    let total = 0;
    let attempts = 0;
    let failures = 0;
    for (const keyword of keywords) {
      // The ledger records the call before it is made: a failed request still
      // counts against Remotive's limits, and a crash must not forget it.
      let reserved = false;
      while (!ctx.abortSignal.aborted) {
        const r = store.reserve(this.clock(), this.gapMs);
        if (r.status === 'ok') {
          reserved = true;
          break;
        }
        if (r.status === 'exhausted') {
          ctx.emitProgress(`Remotive: daily call budget (${DAILY_CALL_BUDGET}/24h) used up — skipping`);
          break;
        }
        await sleep(r.waitMs);
      }
      if (!reserved) break;
      attempts++;

      let json: unknown;
      try {
        json = await fetchJson(buildUrl(keyword), {
          allowedHosts: REMOTIVE_ALLOWED_HOSTS,
          timeoutMs: 30_000,
          // No retries: each attempt would spend another call from the daily budget.
        });
      } catch {
        failures++;
        ctx.emitProgress(`Remotive: "${keyword}" request failed`);
        continue;
      }
      for (const job of parseRemotive(json)) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        total++;
        yield job;
      }
    }
    if (attempts > 0 && failures === attempts) {
      throw new Error('Remotive: all requests failed');
    }
    ctx.emitProgress(`Remotive: ${total} jobs (source: Remotive)`, total);
  }
}
