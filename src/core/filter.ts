import type { Job } from './job';
import { employmentTypesInTitle, type EmploymentType } from './employment-type';
import { explicitNoSponsorship } from './visa-sponsorship';
import type { CompanyStage } from '../llm/schemas';
import {
  countryLevel,
  hasWorldwideMarker,
  placeLabel,
  placesForTerm,
  placesIn,
  placesOverlap,
  placesWithin,
  type PlaceKey,
} from './geo';

export interface Criteria {
  title?: { positive: string[]; negative: string[] };
  location?: {
    remote_required: boolean;
    /** Places the user wants to work in. Constrains on-site/hybrid jobs; together
     *  with always_allow it also defines where a geo-restricted remote job must be
     *  open to (the remote-eligibility rule in l1Filter). */
    allowed: string[];
    /** Regions to exclude, applied even to remote roles. */
    block?: string[];
    /** The user's home region(s): a location that names one always passes, even
     *  alongside a blocked region. Also counts as "where the user can work" for the
     *  remote-eligibility rule, so "Remote - India" passes while "Remote - US" fails. */
    always_allow?: string[];
  };
  seniority?: { allowed: ('junior' | 'mid' | 'senior' | 'staff' | 'principal')[] };
  /** Years-of-experience range the user stated. Consumed by the L2 prompt, not L1. */
  experience_years?: { min: number | null; max: number | null } | null;
  salary_min_usd?: number | null;
  salary_currency?: string;
  exclude_companies?: string[];
  /** Empty/absent = any. L1 drops only on an explicit contrary signal (see l1Filter). */
  employment_types?: EmploymentType[];
  /** L1 drops only a JD that explicitly refuses sponsorship. */
  visa_sponsorship_required?: boolean;
  /** Consumed by the L2 prompt, not L1. */
  skills?: { must: string[]; nice: string[] };
  /** exclude is also matched against title/company by L1, the rest is L2's. */
  industries?: { include: string[]; exclude: string[] };
  /** Consumed by the L2 prompt, not L1. */
  company_stage?: CompanyStage[];
}

export interface L1Result {
  pass: boolean;
  reasons: string[];
}

/** The reason l1Filter emits when the title has no positive keyword. A job whose
 *  ONLY reason is this one is a semantic-rescue candidate (runner/semantic-rescue.ts)
 *  — rescue finds them by this exact reason, so keep the string stable. */
export const TITLE_MISSING_REASON = 'title missing positive keyword';

export interface L1Options {
  /** Reference time for the freshness gate (defaults to Date.now()). */
  now?: number;
  /** Drop dated jobs older than this many days. 0/absent disables the gate; a job
   *  with no posted date always passes. */
  maxAgeDays?: number;
}

// Word-bounded senior/management title markers, consulted ONLY when the criteria
// restricts to junior/mid (see the seniority gate in l1Filter). Deliberately
// EXCLUDES 'lead', 'manager', and 'architect' — those mark a role, not a level
// (Product Manager / Product Lead / Solutions Architect are commonly mid), so
// gating on them would drop real fits. 'staff' counts only before a tech noun,
// since "Staff Accountant/Nurse/Writer" is a plain employee title, and a bare
// 'fellow' is a programme (Research Fellow, AI Fellow) rather than a level. Ladder
// numerals III+ on SDE/engineer/developer titles are senior rungs; "Engineer II"
// stays ungated. Word boundaries keep '\bsr\b' from matching 'SRE' and '\bvp\b'
// from matching 'VPN'. Title-only ⇒ a partial filter: a senior role with a plain
// title still reaches L2 for the JD-based read.
const SENIOR_TITLE_RE = new RegExp(
  [
    String.raw`\b(?:senior|sr|snr|principal|director|vp|head of|distinguished)\b`,
    String.raw`\bstaff\s+(?:software|engineer|engineering|data|ml|machine|ai|applied|product|design|designer|ux|ui|research|researcher|security|platform|infrastructure|cloud|devops|backend|back[\s-]?end|frontend|front[\s-]?end|full[\s-]?stack|site|sre|developer|scientist|architect|mobile|ios|android|systems?|analytics|qa|test|firmware|hardware|network|solutions?)\b`,
    // Trailing negative lookaheads keep a years-of-experience callout ("Flutter
    // Developer 3 Years", "- 3 Yrs Exp", "3-5 Yrs", "Developer - 4 Years") from
    // being misread as ladder rung 3/4/5: reject a bare "-N" range right after
    // the numeral, and reject "N years/yrs/yoe" (optionally with that "-N" range
    // spliced in between, as in "3-5 Yrs").
    String.raw`\b(?:sde|swe|engineer|developer|programmer)\s*[-–]?\s*(?:iii|iv|v|3|4|5)(?![\w+.])(?!-\d)(?!\s*(?:-\s*\d+\s*)?(?:yrs?|years?|yoe)\b)`,
  ].join('|'),
  'i',
);

// Criteria levels that count as "senior and up". If the allowed set names none of
// these, the user asked for junior/mid only and the seniority gate engages.
const SENIOR_LEVELS = new Set(['senior', 'staff', 'principal']);

// Industry words that are also job functions: an "Insurance Data Engineer" or a
// "Finance Platform Engineer" works in finance without the employer being excluded
// for it, and "Security Engineer" says nothing about the industry at all. Such an
// exclude term is matched against the company name only, never the title. Anything
// industry-specific ("crypto", "casino", "tobacco") still matches titles.
const FUNCTION_WORDS = new Set([
  'finance', 'financial', 'banking', 'bank', 'insurance', 'security', 'health', 'healthcare',
  'medical', 'payments', 'payment', 'ads', 'advertising', 'marketing', 'sales', 'data', 'legal',
  'gaming', 'game', 'games', 'media', 'energy', 'education', 'retail', 'consulting', 'cloud',
  'software', 'tech', 'technology', 'ai',
]);
const isFunctionWord = (t: Term) => FUNCTION_WORDS.has(normalizeForMatch(t.term).trim());

/** Lowercase, strip diacritics, and treat -, _, / and dashes as spaces so
 *  "Full-Stack" / "CI/CD" read like "full stack" / "ci cd". */
function normalizeForMatch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[-_/\u2013\u2014]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Whole-word matcher for a criteria term, or null for a blank term. A boundary
 *  is required only on a side where the term starts/ends with a letter or digit,
 *  so "c++", "c#" and ".net" still match ("ASP.NET"). A space in the term is
 *  optional in the text, so "full stack" also matches "Fullstack". */
function termRegex(term: string): RegExp | null {
  const n = normalizeForMatch(term).trim();
  if (!n) return null;
  const body = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, ' ?');
  const before = /^[a-z0-9]/.test(n) ? '(?<![a-z0-9])' : '';
  const after = /[a-z0-9]$/.test(n) ? '(?![a-z0-9])' : '';
  return new RegExp(before + body + after);
}

/** True when `term` occurs in `hay` as a whole word/phrase: "us" is not in
 *  "Austin", "intern" not in "International", "java" not in "JavaScript". */
export function termMatches(hay: string | null | undefined, term: string): boolean {
  const re = termRegex(term);
  return !!re && !!hay && re.test(normalizeForMatch(hay));
}

interface Term {
  term: string;
  re: RegExp;
  places: Set<PlaceKey>;
}

interface Compiled {
  titlePos: Term[];
  titleNeg: Term[];
  allowed: Term[];
  block: Term[];
  alwaysAllow: Term[];
  excludes: Term[];
  industryExcludes: Term[];
  /** Function-ambiguous industry words, matched against the company name only. */
  industryExcludesCompanyOnly: Term[];
  wantedTypes: Set<EmploymentType>;
  /** Places of allowed ∪ always_allow: where the user can work. */
  home: Set<PlaceKey>;
  floorCurrency: string;
}

// Blank or whitespace-only terms are dropped here: an empty exclude would match
// every company, and an empty positive/allowed term would disable its rule.
function compileTerms(list: unknown[] | undefined, withPlaces: boolean): Term[] {
  const out: Term[] = [];
  for (const raw of list ?? []) {
    const term = String(raw ?? '').trim();
    const re = termRegex(term);
    if (re) out.push({ term, re, places: withPlaces ? placesForTerm(term) : new Set() });
  }
  return out;
}

// The runner passes one criteria object for the whole scan, so compiling per
// object keeps the per-job cost to a few regex tests (no RegExp construction).
const compiledCache = new WeakMap<Criteria, Compiled>();

function compile(c: Criteria): Compiled {
  const hit = compiledCache.get(c);
  if (hit) return hit;
  const allowed = compileTerms(c.location?.allowed, true);
  const alwaysAllow = compileTerms(c.location?.always_allow, true);
  const home = new Set<PlaceKey>();
  for (const t of [...allowed, ...alwaysAllow]) for (const p of t.places) home.add(p);
  const industryTerms = compileTerms(c.industries?.exclude, false);
  const k: Compiled = {
    titlePos: compileTerms(c.title?.positive, false),
    titleNeg: compileTerms(c.title?.negative, false),
    allowed,
    block: compileTerms(c.location?.block, true),
    alwaysAllow,
    excludes: compileTerms(c.exclude_companies, false),
    industryExcludes: industryTerms.filter((t) => !isFunctionWord(t)),
    industryExcludesCompanyOnly: industryTerms.filter(isFunctionWord),
    wantedTypes: new Set(c.employment_types ?? []),
    home,
    floorCurrency: (c.salary_currency?.trim() || 'USD').toUpperCase(),
  };
  compiledCache.set(c, k);
  return k;
}

export function l1Filter(job: Job, c: Criteria, opts: L1Options = {}): L1Result {
  const reasons: string[] = [];
  const k = compile(c);

  if (c.title) {
    const t = normalizeForMatch(job.title ?? '');
    if (k.titlePos.length > 0 && !k.titlePos.some((x) => x.re.test(t))) {
      reasons.push(TITLE_MISSING_REASON);
    }
    const negHit = k.titleNeg.find((x) => x.re.test(t));
    if (negHit) reasons.push(`title has negative keyword "${negHit.term}"`);
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
    const raw = job.location ?? '';
    const loc = raw.toLowerCase();
    const isRemote =
      job.remote === true ||
      /\b(remote|distributed|anywhere|worldwide)\b/.test(loc);
    const isOnsite = /\b(onsite|on-?site|hybrid)\b/.test(loc);

    if (c.location.remote_required && isOnsite && !isRemote) {
      reasons.push(`location not remote: "${job.location}"`);
    }

    // Location tiers, precedence always_allow > block > allowed. A missing or
    // empty job location always passes (don't penalize sparse provider data).
    // A term matches as a whole word OR through the gazetteer (src/core/geo.ts),
    // so allowed ["india"] passes "Bangalore". always_allow/allowed accept any
    // overlap ("APAC" could include India); block needs the job place to lie
    // inside the blocked one ("Austin, TX" is in the US, "Americas" is not wholly
    // US), so a vague region is never dropped on a guess.
    // always_allow rescues a multi-region string that also names a blocked
    // region (e.g. "Remote, NY or India" passes on NY even if India is blocked).
    // block is an explicit exclusion that applies even to remote roles — it
    // catches geo-restricted remote listings like "Remote (US only)".
    if (loc.trim() !== '') {
      const hay = normalizeForMatch(raw);
      let places: Set<PlaceKey> | undefined;
      const jobPlaces = () => (places ??= placesIn(raw));
      const overlaps = (t: Term) =>
        t.re.test(hay) || (t.places.size > 0 && placesOverlap(jobPlaces(), t.places));
      const inside = (t: Term) =>
        t.re.test(hay) || (t.places.size > 0 && placesWithin(jobPlaces(), t.places));

      if (!k.alwaysAllow.some(overlaps)) {
        const blockHit = k.block.find(inside);
        if (blockHit) {
          reasons.push(`location "${job.location}" blocked by "${blockHit.term}"`);
        } else if (!isRemote) {
          if (k.allowed.length > 0 && !k.allowed.some(overlaps)) {
            reasons.push(`location "${job.location}" not in allowed list`);
          }
        } else if (
          // Remote eligibility: a remote job restricted to places the user can't
          // work from ("Remote - US" on an India search) is not remote for them.
          // Plain "Remote", unrecognized places, and worldwide markers pass —
          // only a positively recognized, non-overlapping place fails.
          k.home.size > 0 &&
          !k.allowed.some((t) => t.re.test(hay)) &&
          !hasWorldwideMarker(raw) &&
          jobPlaces().size > 0 &&
          !placesOverlap(jobPlaces(), k.home)
        ) {
          const where = [...countryLevel(jobPlaces())].map(placeLabel).sort().join(', ');
          reasons.push(`remote but restricted to ${where}`);
        }
      }
    }
  }

  if (k.excludes.length > 0) {
    const company = normalizeForMatch(job.company ?? '');
    if (k.excludes.some((x) => x.re.test(company))) reasons.push(`company excluded`);
  }

  // Industry excludes look at company and title only (function-ambiguous words at
  // company only, see FUNCTION_WORDS). A JD mentioning "crypto" or
  // "defense" in passing says nothing about the employer's industry, so the rest of
  // the exclusion is L2's call.
  if (k.industryExcludes.length > 0 || k.industryExcludesCompanyOnly.length > 0) {
    const company = normalizeForMatch(job.company ?? '');
    const title = normalizeForMatch(job.title ?? '');
    const hit =
      k.industryExcludes.find((x) => x.re.test(company) || x.re.test(title)) ??
      k.industryExcludesCompanyOnly.find((x) => x.re.test(company));
    if (hit) reasons.push(`industry excluded: "${hit.term}"`);
  }

  // Employment type: drop only when the title or the ATS's structured field states a
  // type and none of the stated types is wanted. "Engineer (Contract) - Full time"
  // states both, so a wanted one saves it. No stated type passes.
  if (k.wantedTypes.size > 0) {
    const stated = employmentTypesInTitle(normalizeForMatch(job.title ?? ''));
    if (job.employment_type) stated.add(job.employment_type);
    if (stated.size > 0 && ![...stated].some((t) => k.wantedTypes.has(t))) {
      reasons.push(`employment type ${[...stated].join('/')} not wanted (${[...k.wantedTypes].join('/')})`);
    }
  }

  if (c.visa_sponsorship_required) {
    const refusal = explicitNoSponsorship(job.jd_text);
    if (refusal) reasons.push(`no visa sponsorship ("${refusal}")`);
  }

  // Salary floor compares amounts only when both currencies are known and equal.
  // Amounts are native (the _usd suffix is legacy), so cross-currency or
  // unknown-currency salaries can't be compared deterministically — they pass and
  // defer to L2 (mirrors the missing-data philosophy: don't drop what we can't
  // evaluate). A criteria row predating salary_currency defaults to USD, so it
  // still filters USD-tagged jobs. A range is compared by its top: $140k–$190k
  // can pay a $150k floor, so only a range entirely below the floor fails.
  const jobPay = job.salary_max_usd ?? job.salary_min_usd;
  if (
    c.salary_min_usd &&
    jobPay != null &&
    job.salary_currency != null &&
    k.floorCurrency === job.salary_currency.trim().toUpperCase() &&
    jobPay < c.salary_min_usd
  ) {
    reasons.push(`salary ${jobPay} ${job.salary_currency} below floor ${c.salary_min_usd}`);
  }

  // Freshness gate: drop jobs whose posted date is older than the user's window.
  // Deterministic + zero-token — trims stale postings from the L2 queue (the
  // binding cost constraint). A job with no posted date passes (don't drop what we
  // can't date); a within-window or future date passes too. "Older" is strict:
  // a job posted exactly maxAgeDays ago still passes.
  if (opts.maxAgeDays && opts.maxAgeDays > 0 && job.posted_at != null) {
    const now = opts.now ?? Date.now();
    const ageDays = Math.floor((now - job.posted_at) / 86_400_000);
    if (ageDays > opts.maxAgeDays) {
      reasons.push(`posted ${ageDays}d ago, older than ${opts.maxAgeDays}d freshness window`);
    }
  }

  return { pass: reasons.length === 0, reasons };
}
