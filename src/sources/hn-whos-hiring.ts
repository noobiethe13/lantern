import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { callGeminiValidated } from '../llm/gemini';
import { HNJobsShape, type HNJob } from '../llm/schemas';
import { hnExtractorPrompt } from '../llm/prompts';

const MAX_COMMENT_CHARS = 8192;
const MAX_COMMENTS_PER_RUN = 5; // Top N comments

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
    const toProcess = Math.min(comments.length, MAX_COMMENTS_PER_RUN);
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
        jobs = await callGeminiValidated(
          { model: 'gemini-2.5-flash', prompt: hnExtractorPrompt(text) },
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
