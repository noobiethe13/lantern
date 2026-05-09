import type { Job } from './job';

export interface Criteria {
  title?: { positive: string[]; negative: string[] };
  location?: { remote_required: boolean; allowed: string[] };
  seniority?: { allowed: ('junior' | 'mid' | 'senior' | 'staff' | 'principal')[] };
  salary_min_usd?: number | null;
  exclude_companies?: string[];
}

export interface L1Result {
  pass: boolean;
  reasons: string[];
}

export function l1Filter(job: Job, c: Criteria): L1Result {
  const reasons: string[] = [];
  const lower = (s?: string) => (s ?? '').toLowerCase();

  if (c.title) {
    const t = lower(job.title);
    const pos = c.title.positive.map(k => k.toLowerCase());
    const neg = c.title.negative.map(k => k.toLowerCase());
    if (pos.length > 0 && !pos.some(k => t.includes(k))) {
      reasons.push(`title missing positive keyword`);
    }
    const negHit = neg.find(k => t.includes(k));
    if (negHit) reasons.push(`title has negative keyword "${negHit}"`);
  }

  if (c.location?.remote_required) {
    const loc = lower(job.location);
    const isRemote =
      job.remote === true ||
      /\b(remote|distributed|anywhere|worldwide)\b/.test(loc);
    const isOnsite = /\b(onsite|on-?site|hybrid)\b/.test(loc);
    if (isOnsite && !isRemote) reasons.push(`location not remote: "${job.location}"`);
  }

  if (
    c.exclude_companies?.some(x => lower(job.company).includes(x.toLowerCase()))
  ) {
    reasons.push(`company excluded`);
  }

  if (
    c.salary_min_usd &&
    job.salary_min_usd != null &&
    job.salary_min_usd < c.salary_min_usd
  ) {
    reasons.push(`salary ${job.salary_min_usd} below floor ${c.salary_min_usd}`);
  }

  return { pass: reasons.length === 0, reasons };
}
