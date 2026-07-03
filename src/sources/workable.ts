import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchText } from '../core/fetch';

const WORKABLE_HOST = 'apply.workable.com';

/**
 * Parse Workable's public markdown feed. Workable's JSON API needs an auth
 * token; the `/<slug>/jobs.md` markdown table is the only no-auth surface. Rows
 * look like:
 *   | Title | Department | Location | Type | Salary | Posted | [View](url.md) |
 * The `[View]` link is validated against `https://apply.workable.com/…`; rows
 * with no on-host URL or no title are dropped.
 */
export function parseWorkableMarkdown(text: string, company: string): Job[] {
  if (typeof text !== 'string') return [];

  const jobs: Job[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|') || !line.includes('[View]')) continue;
    const cols = line.split('|').map(c => c.trim());
    // ['', title, dept, location, type, salary, posted, '[View](url.md)', '']
    if (cols.length < 8) continue;
    const title = cols[1];
    if (!title || title === 'Title') continue;
    const location = cols[3] || '';

    const urlMatch = line.match(/\[View\]\(([^)]+)\)/);
    let url = urlMatch ? urlMatch[1] : '';
    if (url.endsWith('.md')) url = url.slice(0, -3);
    if (!url) continue;

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname !== WORKABLE_HOST) continue;
      url = parsed.href;
    } catch {
      continue;
    }

    // TODO(jd_text deferred): the public markdown feed carries no description
    // body, only the row fields — so Workable jobs reach L2 without jd_text.
    jobs.push({ title, url, company, location });
  }
  return jobs;
}

export class WorkableAdapter implements SourceAdapter {
  type = 'workable' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };
    assertValidSlug(identifier, 'Workable account slug');
    const feedUrl = `https://${WORKABLE_HOST}/${identifier}/jobs.md`;
    ctx.emitProgress(`Fetching ${display_name} (Workable)…`);

    const text = await fetchText(feedUrl, { allowedHosts: [WORKABLE_HOST] });
    const jobs = parseWorkableMarkdown(text, display_name);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
