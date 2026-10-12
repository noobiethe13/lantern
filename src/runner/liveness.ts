import { load as cheerioLoad } from 'cheerio';
import { db } from '../db/client';
import { classifyLiveness, isSpaHost, type LivenessInput } from '../core/liveness';
import { assertSafeHttpUrl } from '../core/fetch';
import { recomputeLegitimacy } from './legitimacy';
import { getScanningState } from './scan';
import { isBrowserAvailable, renderPage } from './browser';

const FETCH_TIMEOUT_MS = 10_000;
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000; // 24 h
// Liveness re-fetches whatever URL a scraped/aggregator posting carries — that's
// untrusted input, so it gets the same SSRF guard as every other outbound fetch
// (rule §9), applied to the initial URL AND every redirect hop (a same-origin
// posting can still 302 somewhere private).
export const MAX_REDIRECTS = 5;
// Cap the body read — a posting has no size contract, and reading an unbounded
// response into memory on every stale-shortlist sweep is its own resource risk.
export const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

interface EligibleJob {
  id: number;
  url: string;
  liveness_checked_at: number | null;
}

export interface LivenessSummary {
  checked: number;
  active: number;
  expired: number;
  uncertain: number;
  skipped: number;
}

/**
 * Build a LivenessInput from a fetched or rendered page. Strips site chrome
 * (nav/header/footer) before collecting apply controls and body text — chrome
 * links like "Apply now" point at the careers index, not this posting, so a dead
 * job would otherwise classify as active off its own nav. Also strips
 * script/style/noscript/template — inline JSON-LD and i18n strings ("This job
 * is no longer available", "Applications closed for the 2024 cohort") living in
 * those elements leaked into $.text() and triggered false 'expired'
 * classifications on pages that were actually still live.
 */
export function inputFromHtml(status: number, finalUrl: string, html: string): LivenessInput {
  const $ = cheerioLoad(html);
  $('nav, header, footer, script, style, noscript, template').remove();
  const applyControls: string[] = [];
  $('a, button').each((_, el) => {
    const text = $(el).text().trim();
    if (text) applyControls.push(text);
  });
  return { status, finalUrl, bodyText: $.text(), applyControls };
}

/** Read a response body as text, abandoning the stream past MAX_BODY_BYTES
 *  (a slight overshoot up to one chunk is fine — this is a safety cap, not an
 *  exact limit) instead of buffering an unbounded posting into memory. */
async function readCappedText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let received = 0;
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    received += value.byteLength;
    if (received >= MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return out;
}

export async function fetchLiveness(url: string): Promise<LivenessInput | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let current: URL;
    try {
      current = assertSafeHttpUrl(url);
    } catch {
      return null;
    }

    // Manual redirect handling: 'follow' would let a public posting URL 302 to
    // a private host with no guard in between. Validate every hop's target the
    // same way as the initial URL, and give up past MAX_REDIRECTS.
    let res: Response | undefined;
    for (let hop = 0; ; hop++) {
      res = await fetch(current.toString(), {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; lantern/1.0)' },
      });
      if (res.status < 300 || res.status >= 400) break;
      if (hop >= MAX_REDIRECTS) return null;
      const location = res.headers.get('location');
      if (!location) break;
      try {
        current = assertSafeHttpUrl(new URL(location, current).href);
      } catch {
        return null;
      }
    }
    if (!res) return null;

    const bodyText = await readCappedText(res);
    return inputFromHtml(res.status, current.toString(), bodyText);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Browser-tier fallback for liveness: render the posting in the optional
 * deterministic browser and build a LivenessInput from the rendered DOM. Returns
 * null when the engine is absent or rendering fails. Used ONLY to resolve an
 * 'uncertain' fetch verdict (client-rendered SPA shell / JS-injected apply
 * controls) — never in bulk, never on the default fetch path.
 */
async function browserLiveness(url: string): Promise<LivenessInput | null> {
  const page = await renderPage(url, { timeoutMs: 20_000 }).catch(() => null);
  if (!page) return null;
  return inputFromHtml(page.status ?? 200, page.finalUrl, page.html);
}

export async function runLivenessCheck(): Promise<LivenessSummary> {
  if (getScanningState()) {
    return { checked: 0, active: 0, expired: 0, uncertain: 0, skipped: 1 };
  }

  const staleThreshold = Date.now() - RECHECK_AFTER_MS;

  const jobs = db.query<EligibleJob, [number]>(
    `SELECT j.id, j.url, j.liveness_checked_at
     FROM jobs j
     WHERE j.status = 'shortlist'
       AND (j.liveness_checked_at IS NULL OR j.liveness_checked_at < ?)`,
  ).all(staleThreshold);

  const summary: LivenessSummary = { checked: 0, active: 0, expired: 0, uncertain: 0, skipped: 0 };

  for (const job of jobs) {
    const input = await fetchLiveness(job.url);

    if (!input) {
      summary.skipped++;
      continue;
    }

    let result = classifyLiveness(input).result;

    // A client-rendered posting reads 'uncertain' from fetch+cheerio (empty SPA
    // shell). Gate the fallback on a known SPA host (see CLAUDE.md rule 6) so we don't spend
    // a browser launch on every uncertain posting — render deterministically and
    // re-classify only there, adopting a conclusive verdict.
    if (result === 'uncertain' && isSpaHost(input.finalUrl) && (await isBrowserAvailable())) {
      const rendered = await browserLiveness(job.url);
      if (rendered) {
        const browserResult = classifyLiveness(rendered).result;
        if (browserResult !== 'uncertain') result = browserResult;
      }
    }

    const now = Date.now();
    db.run(
      'UPDATE jobs SET liveness = ?, liveness_checked_at = ? WHERE id = ?',
      [result, now, job.id],
    );
    // Liveness is a legitimacy input — refresh the job's ghost-job signal.
    recomputeLegitimacy(job.id);

    summary.checked++;
    summary[result]++;
  }

  return summary;
}
