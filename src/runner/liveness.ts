import { join } from 'node:path';
import { load as cheerioLoad } from 'cheerio';
import { db } from '../db/client';
import { classifyLiveness, MIN_CONTENT, type LivenessInput } from '../core/liveness';
import { getScanningState } from './scan';

const FETCH_TIMEOUT_MS = 10_000;
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000; // 24 h
const SPA_TYPES = new Set(['ashby', 'lever', 'generic-url']);

// Playwright is sequential — one tab at a time across the whole process.
let playwrightBusy = false;

interface EligibleJob {
  id: number;
  url: string;
  source_type: string;
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

async function fetchLivenessPlaywright(url: string): Promise<LivenessInput | null> {
  if (playwrightBusy) return null;
  playwrightBusy = true;
  try {
    const { chromium } = await import('playwright');
    const profilePath = join(process.cwd(), 'data', 'browser-profile');
    const browser = await chromium.launchPersistentContext(profilePath, { headless: true });
    try {
      const page = await browser.newPage();
      try {
        const res = await page.goto(url, { timeout: 30_000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2_000);

        const status = res?.status() ?? 200;
        const finalUrl = page.url();
        const bodyText: string = await page.evaluate(() => document.body.innerText ?? '');
        const applyControls: string[] = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('a, button'));
          return els.map(e => (e as HTMLElement).innerText?.trim() ?? '').filter(Boolean);
        });

        return { status, finalUrl, bodyText, applyControls };
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error(`[liveness] playwright error for ${url}: ${err}`);
    return null;
  } finally {
    playwrightBusy = false;
  }
}

export async function runLivenessCheck(): Promise<LivenessSummary> {
  if (getScanningState()) {
    return { checked: 0, active: 0, expired: 0, uncertain: 0, skipped: 1 };
  }

  const staleThreshold = Date.now() - RECHECK_AFTER_MS;

  const jobs = db.query<EligibleJob, [number]>(
    `SELECT j.id, j.url, s.type AS source_type, j.liveness_checked_at
     FROM jobs j
     LEFT JOIN sources s ON s.id = j.source_id
     WHERE j.status = 'shortlist'
       AND (j.liveness_checked_at IS NULL OR j.liveness_checked_at < ?)`,
  ).all(staleThreshold);

  const summary: LivenessSummary = { checked: 0, active: 0, expired: 0, uncertain: 0, skipped: 0 };

  for (const job of jobs) {
    let input = await fetchLiveness(job.url);

    // Escalate to Playwright for SPA-board sources with thin/no content
    if (
      SPA_TYPES.has(job.source_type) &&
      (!input || input.bodyText.trim().length < MIN_CONTENT || input.applyControls.length === 0)
    ) {
      input = await fetchLivenessPlaywright(job.url) ?? input;
    }

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
