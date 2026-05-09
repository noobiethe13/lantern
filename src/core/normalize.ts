import type { Job } from './job';

export interface DbJobRow {
  source_id: number;
  external_id: string | null;
  url: string;
  title: string;
  company: string;
  location: string | null;
  remote: number | null;
  salary_min_usd: number | null;
  salary_max_usd: number | null;
  posted_at: number | null;
  jd_text: string | null;
  content_hash: string;
}

export function toDbRow(job: Job, sourceId: number, hash: string): DbJobRow {
  return {
    source_id: sourceId,
    external_id: job.external_id ?? null,
    url: job.url,
    title: job.title,
    company: job.company,
    location: job.location ?? null,
    remote: job.remote == null ? null : job.remote ? 1 : 0,
    salary_min_usd: job.salary_min_usd ?? null,
    salary_max_usd: job.salary_max_usd ?? null,
    posted_at: job.posted_at ?? null,
    jd_text: job.jd_text ?? null,
    content_hash: hash,
  };
}
