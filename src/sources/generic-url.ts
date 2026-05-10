import { join } from 'node:path';
import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { callGeminiValidated } from '../llm/gemini';
import { HTMLJobsShape } from '../llm/schemas';
import { htmlExtractorPrompt } from '../llm/prompts';

const MAX_HTML_CHARS = 32 * 1024; // 32KB — critical rule §9

export class GenericUrlAdapter implements SourceAdapter {
  type = 'generic-url' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier: url, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };

    ctx.emitProgress(`${display_name}: fetching via Playwright…`);

    // Dynamic import keeps playwright out of the module graph for sources that
    // don't need it. Playwright must be sequential (one tab at a time).
    const { chromium } = await import('playwright');
    const profilePath = join(process.cwd(), 'data', 'browser-profile');

    const browser = await chromium.launchPersistentContext(profilePath, {
      headless: true,
    });

    try {
      const page = await browser.newPage();
      try {
        await page.goto(url, { timeout: 30_000, waitUntil: 'domcontentloaded' });
        // Wait for SPA hydration (matches sibling-tool tactic)
        await page.waitForTimeout(2_000);

        const innerText: string = await page.evaluate(() => document.body.innerText);
        const outerHTML: string = await page.evaluate(() => document.body.outerHTML);

        // Prefer innerText (leaner); fall back to outerHTML for content-sparse SPAs
        const content = innerText.length > 200
          ? innerText.slice(0, MAX_HTML_CHARS)
          : outerHTML.slice(0, MAX_HTML_CHARS);

        ctx.emitProgress(`${display_name}: extracting jobs via Gemini Pro…`);

        const jobs = await callGeminiValidated(
          { model: 'gemini-2.5-pro', prompt: htmlExtractorPrompt(content, url) },
          HTMLJobsShape
        );

        ctx.emitProgress(`${display_name}: ${jobs.length} jobs extracted`, jobs.length);

        for (const job of jobs) {
          if (!job.title || !job.company) continue;
          yield {
            url: job.url || url,
            title: job.title,
            company: job.company,
            location: job.location,
            remote: job.remote,
            salary_min_usd: job.salary_min_usd,
            jd_text: job.jd_text,
          };
        }
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
}
