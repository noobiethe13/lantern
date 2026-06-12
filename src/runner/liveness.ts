import { load as cheerioLoad } from 'cheerio';
import { db } from '../db/client';
import { classifyLiveness, type LivenessInput } from '../core/liveness';
import { getScanningState } from './scan';

const FETCH_TIMEOUT_MS = 10_000;
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000; // 24 h

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

async function fetchLiveness(url: string): Promise<LivenessInput | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; lantern/1.0)' },
    });
    const finalUrl = res.url ?? url;
    const bodyText = await res.text();
    const $ = cheerioLoad(bodyText);
    // Site chrome contains links like "Apply now" pointing at the careers
    // index, not this posting — a dead job would classify as active off its
    // own nav. Strip chrome before collecting controls and body text.
    $('nav, header, footer').remove();
    const applyControls: string[] = [];
    $('a, button').each((_, el) => {
      const text = $(el).text().trim();
      if (text) applyControls.push(text);
    });
    return { status: res.status, finalUrl, bodyText: $.text(), applyControls };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
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

    const { result } = classifyLiveness(input);
    const now = Date.now();
    db.run(
      'UPDATE jobs SET liveness = ?, liveness_checked_at = ? WHERE id = ?',
      [result, now, job.id],
    );

    summary.checked++;
    summary[result]++;
  }

  return summary;
}
