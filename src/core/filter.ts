import type { Job } from './job';

export interface Criteria {
  title?: { positive: string[]; negative: string[] };
  location?: {
    remote_required: boolean;
    allowed: string[];
    block?: string[];
    always_allow?: string[];
  };
  seniority?: { allowed: ('junior' | 'mid' | 'senior' | 'staff' | 'principal')[] };
  salary_min_usd?: number | null;
  salary_currency?: string;
  exclude_companies?: string[];
}

export interface L1Result {
  pass: boolean;
  reasons: string[];
}

// Word-bounded senior/management title markers, consulted ONLY when the criteria
// restricts to junior/mid (see the seniority gate in l1Filter). Deliberately
// EXCLUDES 'lead', 'manager', and 'architect' — those mark a role, not a level
// (Product Manager / Product Lead / Solutions Architect are commonly mid), so
// gating on them would drop real fits. Word boundaries keep '\bsr\b' from matching
// 'SRE' and '\bvp\b' from matching 'VPN'. Title-only ⇒ a partial filter: a senior
// role with a plain title still reaches L2 for the JD-based read.
const SENIOR_TITLE_RE =
  /\b(senior|sr|staff|principal|director|vp|head of|distinguished|fellow)\b/i;

// Criteria levels that count as "senior and up". If the allowed set names none of
// these, the user asked for junior/mid only and the seniority gate engages.
const SENIOR_LEVELS = new Set(['senior', 'staff', 'principal']);

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

  // Seniority gate: when the user restricted to junior/mid only, drop titles that
  // advertise a senior+ level. Deterministic + zero-token — it trims the L2 queue
  // of jobs L2 would reject for seniority anyway. Conservative by design (see
  // SENIOR_TITLE_RE); fires ONLY on an explicit junior/mid criteria, so an unstated
  // or senior-inclusive seniority never gates.
  if (c.seniority?.allowed?.length) {
    const wantsSeniorPlus = c.seniority.allowed.some((l) => SENIOR_LEVELS.has(l));
    if (!wantsSeniorPlus && SENIOR_TITLE_RE.test(job.title ?? '')) {
      reasons.push(`title implies senior+ level (criteria allows ${c.seniority.allowed.join('/')})`);
    }
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

    // Location tiers, precedence always_allow > block > allowed. A missing or
    // empty job location always passes (don't penalize sparse provider data).
    // always_allow rescues a multi-region string that also names a blocked
    // region (e.g. "Remote, NY or India" passes on NY even if India is blocked).
    // block is an explicit exclusion that applies even to remote roles — it
    // catches geo-restricted remote listings like "Remote (US only)". The
    // allowed list only constrains non-remote roles, since a remote job is
    // otherwise location-agnostic (L2 can still judge timezone fit). Without the
    // allowed tier, "jobs in the UK" filtered nothing.
    const alwaysAllow = (c.location.always_allow ?? []).map((k) => k.toLowerCase());
    const block = (c.location.block ?? []).map((k) => k.toLowerCase());
    const allowed = (c.location.allowed ?? []).map((k) => k.toLowerCase());
    const hasLoc = loc.trim() !== '';
    const rescued = hasLoc && alwaysAllow.some((k) => loc.includes(k));

    if (hasLoc && !rescued) {
      const blockHit = block.find((k) => loc.includes(k));
      if (blockHit) {
        reasons.push(`location "${job.location}" blocked by "${blockHit}"`);
      } else if (
        allowed.length > 0 &&
        !isRemote &&
        !allowed.some((k) => loc.includes(k))
      ) {
        reasons.push(`location "${job.location}" not in allowed list`);
      }
    }
  }

  if (
    c.exclude_companies?.some(x => lower(job.company).includes(x.toLowerCase()))
  ) {
    reasons.push(`company excluded`);
  }

  // Salary floor compares amounts only when both currencies are known and equal.
  // Amounts are native (the _usd suffix is legacy), so cross-currency or
  // unknown-currency salaries can't be compared deterministically — they pass and
  // defer to L2 (mirrors the missing-data philosophy: don't drop what we can't
  // evaluate). A criteria row predating salary_currency defaults to USD, so it
  // still filters USD-tagged jobs.
  if (
    c.salary_min_usd &&
    job.salary_min_usd != null &&
    job.salary_currency != null &&
    (c.salary_currency ?? 'USD') === job.salary_currency &&
    job.salary_min_usd < c.salary_min_usd
  ) {
    reasons.push(
      `salary ${job.salary_min_usd} ${job.salary_currency} below floor ${c.salary_min_usd}`
    );
  }

  return { pass: reasons.length === 0, reasons };
}
