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

  if (c.location) {
    const loc = lower(job.location);
    const isRemote =
      job.remote === true ||
      /\b(remote|distributed|anywhere|worldwide)\b/.test(loc);
    const isOnsite = /\b(onsite|on-?site|hybrid)\b/.test(loc);

    if (c.location.remote_required && isOnsite && !isRemote) {
      reasons.push(`location not remote: "${job.location}"`);
    }

    // Allow-list: when the user named specific places, a non-remote job must
    // match one of them. Mirrors sibling-tool' buildLocationFilter — a missing or
    // empty location passes (don't penalize sparse provider data), and remote
    // roles bypass the list (a remote job is location-agnostic; L2 can still
    // judge timezone fit). Without this, "jobs in the UK" filtered nothing.
    const allowed = (c.location.allowed ?? []).map((k) => k.toLowerCase());
    if (
      allowed.length > 0 &&
      loc.trim() !== '' &&
      !isRemote &&
      !allowed.some((k) => loc.includes(k))
    ) {
      reasons.push(`location "${job.location}" not in allowed list`);
    }
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
