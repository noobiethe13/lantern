import { join } from 'node:path';
import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { callGeminiValidated } from '../llm/gemini';
import { HTMLJobsShape } from '../llm/schemas';
import { xGrokExtractorPrompt } from '../llm/prompts';

const MAX_RESPONSE_CHARS = 32 * 1024;
const RATE_LIMIT_MS = 6 * 60 * 60 * 1000; // 6 hours

// Default prompt template — user can override via source config_json.prompt_template
const DEFAULT_PROMPT_TEMPLATE =
  'Find me X posts from the last 24 hours where people are advertising open job positions. ' +
  'Include the post URL and the author. Return as a markdown list with job title, company, location, and apply link.';

// Selectors for Grok UI — brittle by nature; wrapped in try/catch throughout.
const SELECTORS = {
  inputArea: '[data-testid="tweetTextarea_0"], textarea, [contenteditable="true"]',
  sendButton: '[data-testid="tweetButtonInline"], button[type="submit"], [aria-label*="Send"], [aria-label*="send"]',
  responseContainer: '[data-testid="bot-response-text"], [class*="response"], [class*="message"], article',
  streamingIndicator: '[class*="loading"], [class*="spinner"], [aria-label*="loading"]',
};

export class XGrokAdapter implements SourceAdapter {
  type = 'x-grok' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const config = ctx.config as {
      identifier?: string;
      display_name?: string;
      last_scan_at?: number;
      prompt_template?: string;
    };

    // Rate limit: reject if scanned < 6 hours ago
    if (config.last_scan_at && Date.now() - config.last_scan_at < RATE_LIMIT_MS) {
      ctx.emitProgress('X/Grok: rate limit — last scan was less than 6 hours ago, skipping');
      return;
    }

    const promptText = config.prompt_template ?? DEFAULT_PROMPT_TEMPLATE;
    ctx.emitProgress('X/Grok: launching headless browser…');

    const { chromium } = await import('playwright');
    const profilePath = join(process.cwd(), 'data', 'browser-profile');

    const browser = await chromium.launchPersistentContext(profilePath, { headless: true });

    let responseText = '';
    try {
      const page = await browser.newPage();
      try {
        await page.goto('https://x.com/i/grok', { timeout: 30_000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3_000);

        // Type the prompt into the Grok input
        const inputEl = await page.$(SELECTORS.inputArea).catch(() => null);
        if (!inputEl) {
          throw new Error('Grok input not found — X.com UI may have changed or session is not logged in');
        }

        await inputEl.click();
        await inputEl.fill(promptText);
        await page.waitForTimeout(500);

        // Submit the prompt
        const sendBtn = await page.$(SELECTORS.sendButton).catch(() => null);
        if (sendBtn) {
          await sendBtn.click();
        } else {
          await inputEl.press('Enter');
        }

        ctx.emitProgress('X/Grok: waiting for Grok response…');

        // Wait for streaming to finish — up to 60s
        await page.waitForTimeout(2_000);
        const maxWaitMs = 60_000;
        const pollIntervalMs = 2_000;
        const deadline = Date.now() + maxWaitMs;

        while (Date.now() < deadline) {
          const isStreaming = await page.$(SELECTORS.streamingIndicator).catch(() => null);
          if (!isStreaming) break;
          await page.waitForTimeout(pollIntervalMs);
        }

        // Capture response text
        const responseEl = await page.$(SELECTORS.responseContainer).catch(() => null);
        if (responseEl) {
          responseText = (await responseEl.innerText().catch(() => '')) ?? '';
        } else {
          // Fallback: grab all visible text from the page
          responseText = await page.evaluate(() => document.body.innerText ?? '');
        }

        responseText = responseText.slice(0, MAX_RESPONSE_CHARS);
        ctx.emitProgress(`X/Grok: captured ${responseText.length} chars, extracting jobs via Gemini Pro…`);
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }

    if (!responseText.trim()) {
      ctx.emitProgress('X/Grok: empty response, skipping extraction');
      return;
    }

    const jobs = await callGeminiValidated(
      { model: 'gemini-2.5-pro', prompt: xGrokExtractorPrompt(responseText) },
      HTMLJobsShape,
    );

    ctx.emitProgress(`X/Grok: ${jobs.length} jobs extracted`, jobs.length);

    for (const job of jobs) {
      if (!job.title || !job.company) continue;
      yield {
        url: job.url || 'https://x.com/i/grok',
        title: job.title,
        company: job.company,
        location: job.location,
        remote: job.remote,
        salary_min_usd: job.salary_min_usd,
        jd_text: job.jd_text,
      };
    }
  }
}
