import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertSafeHttpUrl } from '../core/fetch';
import { llm } from '../llm';
import { HTMLJobsShape } from '../llm/schemas';
import { htmlExtractorPrompt } from '../llm/prompts';
import { SourceFetchError } from '../server/errors';

const MAX_HTML_CHARS = 32 * 1024; // 32KB — critical rule §9
const PAGE_TIMEOUT_MS = 30_000;
const HYDRATION_WAIT_MS = 2_000;

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title: string;
  /** innerText if available, falling back to outerHTML for content-sparse SPAs. */
  content: string;
  contentKind: 'innerText' | 'outerHTML';
}

/**
 * Fetches a single URL via a fresh ephemeral Playwright browser. No cookies,
 * no persisted profile — each call gets a clean session so credentials from
 * the X.com persisted profile (data/browser-profile/) never leak to third
 * parties. Detects auth walls and throws SourceFetchError with kind='auth'.
 */
export async function fetchGenericUrlPage(url: string): Promise<FetchedPage> {
  // Defense in depth — POST /api/sources already runs this check at
  // configuration time. Re-run it here in case a source was inserted by
  // another path (CLI, direct DB write, an older lantern version that
  // predated the boundary validation).
  try {
    assertSafeHttpUrl(url);
  } catch (err) {
    throw new SourceFetchError('http', (err as Error).message);
  }

  const { chromium } = await import('playwright');

  let browser: import('playwright').Browser | null = null;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      throw new SourceFetchError(
        'http',
        `Could not launch Chromium: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      try {
        await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      } catch (err) {
        throw new SourceFetchError(
          'http',
          `Failed to load ${url}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
      // Wait for SPA hydration (matches sibling-tool tactic)
      await page.waitForTimeout(HYDRATION_WAIT_MS);

      const finalUrl = page.url();
      const title = await page.title().catch(() => '');
      const innerText: string = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      const outerHTML: string = await page.evaluate(() => document.body?.outerHTML ?? '').catch(() => '');
      const hasPasswordField: boolean = await page
        .evaluate(() => !!document.querySelector('input[type="password"]'))
        .catch(() => false);

      const useInnerText = innerText.length > 200;
      const content = (useInnerText ? innerText : outerHTML).slice(0, MAX_HTML_CHARS);

      detectLoginWall({ url, finalUrl, title, innerText, hasPasswordField });

      return {
        url,
        finalUrl,
        title,
        content,
        contentKind: useInnerText ? 'innerText' : 'outerHTML',
      };
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Heuristic — best-effort detection of redirects to a sign-in page. We can't
 * reliably distinguish "logged-out wall" from "career page that happens to
 * mention 'sign in'" so the rule is conservative: only fire when multiple
 * weak signals line up (URL redirect to /login OR password field present OR
 * very short content with login keywords in the title).
 */
function detectLoginWall(p: {
  url: string;
  finalUrl: string;
  title: string;
  innerText: string;
  hasPasswordField: boolean;
}): void {
  const finalUrlLower = p.finalUrl.toLowerCase();
  const titleLower = p.title.toLowerCase();
  const text = p.innerText;

  const redirectedToAuth =
    /\/(login|signin|sign-in|sign_in|auth)(?:[/?#]|$)/i.test(finalUrlLower) &&
    !/\/(login|signin|sign-in|sign_in|auth)(?:[/?#]|$)/i.test(p.url.toLowerCase());

  const titleSuggestsAuth = /\b(sign in|log in|login|sign up)\b/.test(titleLower);
  const shortContent = text.length < 1000;

  if (redirectedToAuth) {
    throw new SourceFetchError(
      'auth',
      `Page redirected to a sign-in URL (${p.finalUrl}). The site likely requires login.`
    );
  }
  if (p.hasPasswordField && shortContent) {
    throw new SourceFetchError(
      'auth',
      `Page rendered a password field with little other content (${p.title || p.finalUrl}). The site likely requires login.`
    );
  }
  if (titleSuggestsAuth && shortContent && p.hasPasswordField) {
    throw new SourceFetchError(
      'auth',
      `Page appears to be a login wall (title: "${p.title}").`
    );
  }
}

export class GenericUrlAdapter implements SourceAdapter {
  type = 'generic-url' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier: url, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };

    ctx.emitProgress(`${display_name}: fetching via Playwright…`);

    const page = await fetchGenericUrlPage(url);

    ctx.emitProgress(`${display_name}: extracting jobs via LLM…`);

    let jobs;
    try {
      jobs = await llm.call(
        { task: 'html-extract', prompt: htmlExtractorPrompt(page.content, url) },
        HTMLJobsShape
      );
    } catch (err) {
      throw new SourceFetchError(
        'extract',
        `LLM extraction failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }

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
  }
}
