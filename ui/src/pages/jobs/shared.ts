import { formatMoney, type Job, type JobStatus, type Legitimacy } from '@/lib/api';

// Ghost-job signal styling. 'high' renders nothing in the list — only postings
// with actual red flags earn ink (signal, not accusation).
export function legitimacyColor(band: Legitimacy): string {
  return band === 'suspicious' ? 'var(--danger)' : 'var(--warning)';
}

export function fitLabel(score: number): string {
  return score >= 0.8 ? 'Strong match' : score >= 0.6 ? 'Good match' : score >= 0.4 ? 'Fair match' : 'Weak match';
}

// Statuses the user has actively assigned — these earn a labeled pill in the list.
export const TRIAGED_STATUSES: JobStatus[] = ['shortlist', 'applied', 'interview', 'offer', 'rejected', 'hidden'];

// A taste delta this large (of the +/-0.1 cap) is worth a quiet hint on the row.
export const PREF_HINT_MIN = 0.06;

export const isFlagged = (job: Job) => job.legitimacy === 'caution' || job.legitimacy === 'suspicious';

// Age reflects when the job was POSTED when the source gave a date (more useful
// than when Lantern happened to scan it); fall back to first_seen (scan time)
// only when there's no posted date, and say so in the tooltip.
export function ageOf(job: Job): { short: string; long: string; title: string; today: boolean } {
  const basis = job.posted_at ?? job.first_seen;
  const days = Math.floor((Date.now() - basis) / 86400000);
  const short = days <= 0 ? 'today' : `${days}d`;
  const long = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  const title = job.posted_at != null
    ? `Posted ${new Date(job.posted_at).toLocaleDateString()}`
    : `First seen ${new Date(job.first_seen).toLocaleDateString()} (no posted date)`;
  return { short, long: job.posted_at != null ? `Posted ${long}` : `Seen ${long}`, title, today: days <= 0 };
}

/**
 * The salary line. Native min/max (whichever the source gave) always win over the
 * L2 USD estimate, and always keep the job's own currency — a native max-only
 * amount (Himalayas/RemoteOK/Ashby) must never be paired with an L2 USD min, which
 * would silently relabel a foreign-currency figure as dollars.
 */
export function salaryOf(job: Job): { text: string; estimated: boolean; fromText: boolean } | null {
  const cur = job.salary_currency;
  const { salary_min_usd: min, salary_max_usd: max } = job;
  if (min != null && max != null) return { text: `${formatMoney(min, cur)}–${formatMoney(max, cur)}`, estimated: false, fromText: job.salary_source === 'jd' };
  if (min != null) return { text: `${formatMoney(min, cur)}+`, estimated: false, fromText: job.salary_source === 'jd' };
  if (max != null) return { text: `up to ${formatMoney(max, cur)}`, estimated: false, fromText: job.salary_source === 'jd' };
  const est = job.l2_verdict?.salary_min_usd;
  if (est != null) return { text: `~${formatMoney(est, 'USD')}`, estimated: true, fromText: false };
  return null;
}
