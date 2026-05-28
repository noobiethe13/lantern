import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { llm } from '../llm';
import { HNJobsShape, type HNJob } from '../llm/schemas';
import { hnExtractorPrompt } from '../llm/prompts';

const MAX_COMMENT_CHARS = 8192;
const DEFAULT_MAX_COMMENTS = 5; // Top N comments. Per-source override:
                                // sources.config_json.max_comments (1..50).
const MAX_COMMENTS_CEILING = 50;

interface AlgoliaSearchResult {
  hits: Array<{ objectID: string; title: string }>;
}

interface HNComment {
  id: number;
  text: string | null;
  children?: HNComment[];
}

interface HNStory {
  id: number;
  children?: HNComment[];
}

function stripHtml(html: string): string {
  return html
    .replace(/<p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function jobUrl(job: HNJob, commentId: number, idx: number): string {
  if (job.url) return job.url;
  // Make a unique fallback per job within the comment
  const slug = (job.company + '-' + job.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60);
  return `https://news.ycombinator.com/item?id=${commentId}#${slug}-${idx}`;
}

export class HNWhosHiringAdapter implements SourceAdapter {
  type = 'hn-whos-hiring' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const configMax = (ctx.config.max_comments as number | undefined);
    const maxComments = Number.isFinite(configMax)
      ? Math.max(1, Math.min(MAX_COMMENTS_CEILING, Math.floor(configMax!)))
      : DEFAULT_MAX_COMMENTS;

    ctx.emitProgress("HN Who's Hiring: finding latest thread…");

    const search = (await fetchJson(
      'https://hn.algolia.com/api/v1/search?tags=story&query=Who+is+hiring&restrictSearchableAttributes=title&hitsPerPage=1'
    )) as AlgoliaSearchResult;

    const storyId = search.hits?.[0]?.objectID;
    if (!storyId) throw new Error("HN: could not find latest 'Who's Hiring' thread");

    ctx.emitProgress(`HN Who's Hiring: fetching thread ${storyId}…`);
    const story = (await fetchJson(
      `https://hn.algolia.com/api/v1/items/${storyId}`
    )) as HNStory;

    const comments = story.children ?? [];
    const toProcess = Math.min(comments.length, maxComments);
    ctx.emitProgress(`HN Who's Hiring: processing ${toProcess}/${comments.length} comments…`);

    let processed = 0;
    let found = 0;

    for (const comment of comments) {
      if (ctx.abortSignal.aborted) break;
      if (processed >= toProcess) break;
      processed++;

      if (!comment.text) {
        ctx.emitProgress(`  HN comment ${comment.id}: skipped (empty)`);
        continue;
      }

      const text = stripHtml(comment.text).slice(0, MAX_COMMENT_CHARS);

      let jobs: HNJob[];
      try {
        jobs = await llm.call(
          { task: 'hn-extract', prompt: hnExtractorPrompt(text) },
          HNJobsShape
        );
      } catch (err) {
        ctx.emitProgress(
          `  HN comment ${comment.id}: extraction failed — ${(err as Error).message}`
        );
        continue;
      }

      let jobsFromComment = 0;
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (!job.title || !job.company) continue;
        jobsFromComment++;
        found++;
        yield {
          external_id: `hn-${comment.id}-${i}`,
          url: jobUrl(job, comment.id, i),
          title: job.title,
          company: job.company,
          location: job.location,
          remote: job.remote,
          salary_min_usd: job.salary_min_usd,
          jd_text: job.jd_text,
        };
      }

      ctx.emitProgress(`  HN comment ${comment.id}: ${jobsFromComment} jobs extracted`);
    }

    ctx.emitProgress(`HN Who's Hiring: done — ${found} jobs from ${processed} comments`, found);
  }
}
