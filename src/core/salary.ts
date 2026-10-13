import { placesIn } from './geo';

/**
 * Deterministic salary extraction from free text (job descriptions), plus the
 * period-to-annual normalisation adapters share. Precision-first: a wrong salary
 * makes L1's floor drop a good job, a missing one only defers to L2, so every
 * ambiguity resolves to "no salary".
 */

export type SalaryPeriod = 'year' | 'month' | 'week' | 'day' | 'hour';

export interface SalaryHints {
  /** The job's location string. Only used to resolve a bare `$` to a country's dollar. */
  location?: string | null;
}

export interface ExtractedSalary {
  /** Annual amounts in `currency` (see ANNUAL_FACTOR). null = open-ended on that side. */
  min: number | null;
  max: number | null;
  currency: string;
  /** The period the text stated (or that we inferred as 'year'). */
  period: SalaryPeriod;
}

/**
 * Annualisation convention: 2080 working hours (40h x 52w), 260 working days,
 * 52 weeks, 12 months. Fixed and documented so a derived figure is reproducible.
 */
export const ANNUAL_FACTOR: Record<SalaryPeriod, number> = {
  year: 1,
  month: 12,
  week: 52,
  day: 260,
  hour: 2080,
};

export function annualize(amount: number, period: SalaryPeriod): number {
  return Math.round(amount * ANNUAL_FACTOR[period]);
}

/** Map an ATS interval label ("per-hour-wage", "1 YEAR", "MONTHLY", "hourly") to a period. */
export function periodFromLabel(label: unknown): SalaryPeriod | null {
  if (typeof label !== 'string') return null;
  const s = label.toLowerCase();
  // Half-month, fortnightly and "2 WEEK" style intervals would be annualised by the
  // wrong factor, so only a single unit (no multiplier, or 1) is read.
  if (/(?:bi|semi)[-_ ]?(?:weekly|monthly|annual|yearly)|fortnight|twice|quarter/.test(s)) return null;
  const mult = /^\s*(\d+(?:\.\d+)?)\s+/.exec(s);
  if (mult && Number(mult[1]) !== 1) return null;
  if (/hour|\bhr\b|hourly/.test(s)) return 'hour';
  if (/year|annual|\byr\b|\bpa\b/.test(s)) return 'year';
  if (/month/.test(s)) return 'month';
  if (/week/.test(s)) return 'week';
  if (/day|daily/.test(s)) return 'day';
  return null;
}

/**
 * Annualise structured ATS pay. Returns null for an unknown period or a
 * non-positive amount. A figure must land in the currency's plausible annual
 * band (annual ones only need to clear its floor), which catches a mislabelled
 * period (an annual amount tagged "hourly", or "60" tagged per-year).
 */
export function annualizePay(
  min: number | null,
  max: number | null,
  periodLabel: unknown,
  currency?: string | null,
): { min: number | null; max: number | null } | null {
  const period = periodFromLabel(periodLabel);
  if (!period) return null;
  const conv = (n: number | null) => (n != null && n > 0 ? annualize(n, period) : null);
  const out = { min: conv(min), max: conv(max) };
  if (out.min == null && out.max == null) return null;
  const code = currency?.toUpperCase();
  const bounds = code ? ANNUAL_BOUNDS[code] : undefined;
  if (bounds) {
    // Annual figures only get the lower bound ("60" tagged per-year is a unit slip).
    const ok = (n: number) => n >= bounds[0] && (period === 'year' || n <= bounds[1]);
    if ([out.min, out.max].some((n) => n != null && !ok(n))) return null;
  }
  return out;
}

/**
 * Plausible ANNUAL pay per currency, [min, max] in that currency. Text only:
 * rejects "$2,026", "$50M" and monthly/hourly figures whose period was missing.
 */
const ANNUAL_BOUNDS: Record<string, [number, number]> = {
  USD: [15_000, 2_000_000],
  EUR: [12_000, 1_500_000],
  GBP: [10_000, 1_500_000],
  CAD: [15_000, 2_000_000],
  AUD: [20_000, 2_000_000],
  NZD: [20_000, 1_500_000],
  SGD: [20_000, 1_500_000],
  HKD: [100_000, 10_000_000],
  CHF: [20_000, 1_500_000],
  SEK: [150_000, 10_000_000],
  NOK: [150_000, 10_000_000],
  DKK: [150_000, 8_000_000],
  PLN: [40_000, 3_000_000],
  CZK: [250_000, 12_000_000],
  ZAR: [80_000, 8_000_000],
  AED: [50_000, 6_000_000],
  INR: [150_000, 50_000_000],
  BRL: [30_000, 4_000_000],
  MXN: [100_000, 10_000_000],
  JPY: [2_000_000, 100_000_000],
  ILS: [60_000, 3_000_000],
};

// Stricter floor when the text states no period: a bare "₹1,50,000" is usually a
// monthly figure, so only a lakh-scale amount reads as annual.
const UNSTATED_PERIOD_MIN: Record<string, number> = { INR: 600_000 };

function plausibleAnnual(amount: number, currency: string, periodStated = true): boolean {
  const b = ANNUAL_BOUNDS[currency];
  if (!b) return false;
  const floor = periodStated ? b[0] : (UNSTATED_PERIOD_MIN[currency] ?? b[0]);
  return amount >= floor && amount <= b[1];
}

// Longest alternatives first so "US$" wins over "$" and "CA$" over "C$".
const CURRENCY_TOKENS: Record<string, string> = {
  'US$': 'USD', USD: 'USD', 'CA$': 'CAD', 'C$': 'CAD', CAD: 'CAD', 'AU$': 'AUD', 'A$': 'AUD',
  AUD: 'AUD', 'NZ$': 'NZD', NZD: 'NZD', 'S$': 'SGD', SGD: 'SGD', 'HK$': 'HKD', HKD: 'HKD',
  '$': '$', '€': 'EUR', EUR: 'EUR', '£': 'GBP', GBP: 'GBP', '₹': 'INR', INR: 'INR', CHF: 'CHF',
  SEK: 'SEK', NOK: 'NOK', DKK: 'DKK', PLN: 'PLN', CZK: 'CZK', ZAR: 'ZAR', AED: 'AED',
  'R$': 'BRL', BRL: 'BRL', MXN: 'MXN', JPY: 'JPY', ILS: 'ILS',
};
const escapeRe = (s: string) => s.replace(/[$]/g, '\\$&');
const CURRENCY_ALT = Object.keys(CURRENCY_TOKENS)
  .sort((a, b) => b.length - a.length)
  .map(escapeRe)
  .join('|');

// Indian lakh grouping first (25,00,000), then western/European grouping, then plain.
const NUMBER = String.raw`\d{1,2}(?:,\d{2}){1,3},\d{3}(?:\.\d{1,2})?|\d{1,3}(?:[.,'’]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?`;
const SUFFIX = String.raw`[kK](?![A-Za-z])|m{1,2}(?![A-Za-z])|\s?(?:thousand|million|lakhs?|lacs?|lpa|crores?)(?![A-Za-z])`;

const TOKEN_RX = new RegExp(
  String.raw`(?<![\w$€£₹])(?:(?<pre>${CURRENCY_ALT})\s?)?(?<num>${NUMBER})(?<suf>${SUFFIX})?(?:\s?(?<post>€|£|₹|(?:USD|EUR|GBP|CAD|AUD|NZD|SGD|HKD|CHF|INR|SEK|NOK|DKK|PLN|ZAR|AED|BRL|MXN)(?![A-Za-z])))?(?![\w])`,
  'gi',
);

const SUFFIX_MULT: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6,
  lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, lpa: 1e5, crore: 1e7, crores: 1e7,
};

interface Tok {
  start: number;
  end: number;
  raw: number;
  value: number;
  suffix: string | null;
  /** ISO code, '$' for a bare dollar sign, or null when the token carries no marker. */
  cur: string | null;
}

/** Digits with western, European or Indian grouping to a number. */
function parseNumber(s: string): number {
  const seps = [...s.matchAll(/[.,'’]/g)];
  if (seps.length === 0) return Number(s);
  const last = seps[seps.length - 1]!;
  const after = s.length - last.index! - 1;
  const strip = (str: string) => str.replace(/[.,'’]/g, '');
  if (seps.length >= 2) {
    const sameSep = seps.every((m) => m[0] === last[0]);
    // 1.234,56 / 1,234.56: the last, different separator is the decimal point.
    if (!sameSep || after !== 3) {
      return Number(`${strip(s.slice(0, last.index!))}.${s.slice(last.index! + 1)}`);
    }
    return Number(strip(s));
  }
  const before = s.slice(0, last.index!);
  if (last[0] === "'" || last[0] === '’') return Number(strip(s));
  if (after === 3 && before.length <= 3 && before !== '0') return Number(strip(s));
  return Number(`${before}.${s.slice(last.index! + 1)}`);
}

function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  for (const m of text.matchAll(TOKEN_RX)) {
    const g = m.groups!;
    const raw = parseNumber(g['num']!);
    if (!Number.isFinite(raw)) continue;
    const suffix = g['suf'] ? g['suf'].trim().toLowerCase() : null;
    // A specific code beats a bare '$' ("$150,000 USD").
    const codes = [g['pre'], g['post']]
      .filter((x): x is string => !!x)
      .map((x) => CURRENCY_TOKENS[x.toUpperCase()] ?? CURRENCY_TOKENS[x])
      .filter((x): x is string => !!x);
    let cur: string | null = codes.find((c) => c !== '$') ?? codes[0] ?? null;
    if (!cur && suffix && ['lakh', 'lakhs', 'lac', 'lacs', 'lpa', 'crore', 'crores'].includes(suffix)) cur = 'INR';
    toks.push({
      start: m.index!,
      end: m.index! + m[0].length,
      raw,
      value: raw * (suffix ? SUFFIX_MULT[suffix]! : 1),
      suffix,
      cur,
    });
  }
  return toks;
}

const PERIOD_WORDS =
  String.raw`years?|yearly|yrs?|annum|annually|annual|p\.?a\.?|hours?|hourly|hrs?|h|months?|monthly|mos?|days?|daily|weeks?|weekly|wks?`;
const PERIOD_AFTER_RX = new RegExp(
  String.raw`^\s*\(?\s*(?:(per|a|an|each|every|/)\s*)?(${PERIOD_WORDS})(?![A-Za-z])`,
  'i',
);
// Words that name a period on their own. "year"/"hour"/"day" need a "per"/"a"/"/".
const BARE_PERIODS = new Set(['yearly', 'annually', 'annual', 'annum', 'pa', 'p.a', 'p.a.', 'hourly', 'monthly', 'daily', 'weekly']);

function periodOfWord(w: string): SalaryPeriod | null {
  const s = w.toLowerCase();
  if (/^(year|yearly|yrs?|years|annum|annually|annual|p\.?a\.?)$/.test(s)) return 'year';
  if (/^(hours?|hourly|hrs?|h)$/.test(s)) return 'hour';
  if (/^(months?|monthly|mos?)$/.test(s)) return 'month';
  if (/^(days?|daily)$/.test(s)) return 'day';
  if (/^(weeks?|weekly|wks?)$/.test(s)) return 'week';
  return null;
}

/** A period phrase starting at `pos` ("/yr", "per hour", "annually"), with its length. */
function periodAt(text: string, pos: number): { period: SalaryPeriod; len: number } | null {
  const m = PERIOD_AFTER_RX.exec(text.slice(pos, pos + 40));
  if (!m) return null;
  const prefix = m[1];
  const word = m[2]!;
  if (!prefix && !BARE_PERIODS.has(word.toLowerCase())) return null;
  // A lone "h" is only a period after a slash ("$60/h").
  if (word.toLowerCase() === 'h' && prefix !== '/') return null;
  const period = periodOfWord(word);
  return period ? { period, len: m[0].length } : null;
}

/** Period named in the few words before the figure ("hourly rate:", "annual salary of"). */
function periodBefore(before: string): SalaryPeriod | null {
  const tail = before.slice(-50);
  let found: SalaryPeriod | null = null;
  for (const m of tail.matchAll(/\b(annual(?:ly)?|yearly|hourly|monthly|daily|weekly|per\s+(?:hour|year|month|day|week)|base\s+salary)\b/gi)) {
    const w = m[1]!.toLowerCase();
    found = w.startsWith('per') ? periodOfWord(w.split(/\s+/)[1]!) : w === 'base salary' ? 'year' : periodOfWord(w);
  }
  return found;
}

// Money that is not pay. Checked against the few words around the figure.
const NEG_WORDS = new Set([
  'bonus', 'bonuses', 'stipend', 'relocation', 'relocate', 'allowance', 'budget', 'signing', 'sign-on',
  'referral', 'equity', 'stock', 'option', 'options', 'rsu', 'rsus', 'grant', 'investment', 'invested',
  'backed', 'raised', 'raise', 'funding', 'funded', 'valuation', 'valued', 'revenue', 'arr', 'mrr',
  'commission', 'commissions', 'incentive', 'retention', 'match', 'matching', 'reimbursement',
  'reimburse', 'subsidy', 'contribution', 'perk', 'worth', 'bookings', 'quota', 'prize', 'cost',
  'costs', 'price', 'fee', 'fees', 'rent', 'savings', 'save', 'saves', 'saved', 'tuition', 'learning',
  'wellness', 'hsa', 'fsa', 'donation', 'series', 'deal', 'deals', 'credit', 'credits', 'fund',
]);

const STRONG_CUE = /\b(?:base\s+(?:salary|pay|compensation|comp)|(?:annual|starting|yearly|expected|target|hiring|gross)\s+(?:base\s+)?(?:salary|pay|compensation)|salary|salaries|pay\s+(?:range|scale|rate)|compensation\s+range|hourly\s+(?:rate|wage|pay)|wages?)\b/gi;
const MID_CUE = /\b(?:compensation|pay|paid|remuneration|rate|earn|earning|earnings|ctc|lpa)\b/gi;
const OTE_CUE = /\b(?:ote|on[- ]target\s+earnings)\b/gi;
const BASE_ADJACENT = /\bbase(?:\s+(?:salary|pay|compensation|comp|rate))?\s*(?::|of|is|-|–)?\s*$/i;

/**
 * The text a figure's cue and noise checks may read: its own sentence, plus the
 * previous non-empty line when the figure starts a line (a "Salary" heading).
 * Reaching across sentences let "salary $180k. For contractors: $45/hour" lend
 * the salary cue to the contractor rate.
 */
function figureScope(before: string): string {
  const sentence = before.split(/[.!?]\s+/).pop() ?? '';
  const nl = sentence.lastIndexOf('\n');
  if (nl < 0 || sentence.slice(nl).trim() !== '') return nl < 0 ? sentence : sentence.slice(nl + 1);
  const lines = sentence.split('\n').filter((l) => l.trim() !== '');
  return lines[lines.length - 1] ?? '';
}

// Another role's pay, not this job's ("Also hiring: Customer Support, salary $45k").
const OTHER_ROLE_RX = /\b(?:also hiring|we(?:'re| are) (?:also )?hiring (?:for|a)|other (?:open )?(?:roles|positions|openings)|additional (?:roles|positions))\b/i;

/** Score of the cue word nearest before the figure: 3 salary-ish, 2 pay-ish, 1 OTE, 0 none. */
function cueBefore(scope: string): number {
  const win = scope.slice(-100);
  if (BASE_ADJACENT.test(win.slice(-30))) return 3;
  let best: { end: number; score: number } | null = null;
  for (const [rx, score] of [[STRONG_CUE, 3], [MID_CUE, 2], [OTE_CUE, 1]] as const) {
    for (const m of win.matchAll(rx)) {
      const end = m.index! + m[0].length;
      if (!best || end > best.end) best = { end, score };
    }
  }
  return best?.score ?? 0;
}

function cueAfter(text: string, pos: number): number {
  const tail = text.slice(pos, pos + 30);
  if (/^\W{0,3}(?:on[- ]target|ote)\b/i.test(tail)) return 1;
  if (/^\W{0,3}(?:base(?:\s+(?:salary|pay|compensation))?|annual\s+salary|salary)\b/i.test(tail)) return 3;
  return 0;
}

const BOUNDARY_WORDS = new Set(['plus', 'and', 'with', 'or', '+', 'but', 'including', 'depending']);

/** True when the words just after the figure make it non-pay ("10k signing bonus"). */
function negativeAfter(text: string, pos: number): boolean {
  const seg = text.slice(pos, pos + 40).split(/\.\s|,\s|[;\n(]/)[0] ?? '';
  const words = seg.split(/\s+/).filter(Boolean).slice(0, 3);
  for (const w of words) {
    const lw = w.toLowerCase().replace(/[^a-z-]/g, '');
    if (BOUNDARY_WORDS.has(w.toLowerCase()) || BOUNDARY_WORDS.has(lw)) return false;
    if (NEG_WORDS.has(lw)) return true;
  }
  return false;
}

/** True when the last words before the figure make it non-pay ("bonus of up to"). */
function negativeBefore(before: string): boolean {
  const seg = before.split(/[.!?]\s|,\s|[;\n]/).pop() ?? '';
  // Wide enough to reach "stipend" from the third currency in "3,850 USD / 2,310 GBP / 4,300 CAD".
  const words = seg.split(/\s+/).filter(Boolean).slice(-12);
  let negIdx = -1;
  words.forEach((w, i) => {
    if (NEG_WORDS.has(w.toLowerCase().replace(/[^a-z-]/g, ''))) negIdx = i;
  });
  if (negIdx < 0) return false;
  // "equity and salary range of $X": a pay cue after the noise word wins.
  const afterNeg = words.slice(negIdx + 1).join(' ');
  return !/\b(?:salary|pay|compensation|wage|wages|remuneration)\b/i.test(afterNeg);
}

// Codes that are normally written with a dollar sign (Mexican pesos too: "$43,500 MXN").
const DOLLAR_CODES = new Set(['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN']);
const SEP_RX = /^\s*(?:[-–—−]|to|through|thru|until)\s*$/i;
const BETWEEN_AND_RX = /^\s*and\s*$/i;

interface Expr {
  start: number;
  end: number;
  lo: number | null;
  hi: number | null;
  cur: string | null;
  isRange: boolean;
  gapPeriod: SalaryPeriod | null;
}

function pairExpr(text: string, t1: Tok, t2: Tok): Expr | 'reject' | null {
  let gap = text.slice(t1.end, t2.start);
  if (gap.length > 30) return null;
  let gapPeriod: SalaryPeriod | null = null;
  const p = periodAt(gap, 0);
  if (p) {
    gapPeriod = p.period;
    gap = gap.slice(p.len);
  }
  const isAnd = BETWEEN_AND_RX.test(gap) && /between\s*$/i.test(text.slice(Math.max(0, t1.start - 15), t1.start));
  if (!SEP_RX.test(gap) && !isAnd) return null;

  // A bare first figure only joins a range it can be read against: the second
  // carries a k/m/lakh suffix ("150-190k"), or it is itself a four-digit-plus amount.
  const t1Bare = t1.cur == null;
  if (t1Bare && !(t2.suffix && !t1.suffix) && t1.value < 1000) return null;

  let v1 = t1.value;
  let v2 = t2.value;
  if (!t1.suffix && t2.suffix && t1.raw < t2.raw) v1 = t1.raw * SUFFIX_MULT[t2.suffix]!;
  if (!t2.suffix && t1.suffix && t2.raw < 1000) v2 = t2.raw * SUFFIX_MULT[t1.suffix]!;

  const specific = [t1.cur, t2.cur].filter((c): c is string => !!c && c !== '$');
  if (new Set(specific).size > 1) return 'reject';
  // A bare '$' beside a non-dollar code ("$150k - 190k EUR") is a conflict, not a hint.
  const sign = [t1.cur, t2.cur].includes('$');
  if (sign && specific.length && !DOLLAR_CODES.has(specific[0]!)) return 'reject';
  const cur = specific[0] ?? t1.cur ?? t2.cur;
  if (!cur) return null;
  if (v2 < v1 || v1 <= 0 || v2 / v1 > 4) return 'reject';
  return { start: t1.start, end: t2.end, lo: v1, hi: v2, cur, isRange: true, gapPeriod };
}

const MAX_ONLY_RX = /(?:up\s+to|max(?:imum)?(?:\s+of)?|not\s+(?:to\s+)?exceed|capped\s+at)\s*:?\s*$/i;
const MIN_ONLY_RX = /(?:\bfrom|starting(?:\s+(?:at|from))?|starts?\s+at|minimum(?:\s+of)?|\bmin\.?|at\s+least|upwards?\s+of)\s*:?\s*$/i;

function singleExpr(text: string, t: Tok): Expr | null {
  if (!t.cur) return null;
  const before = text.slice(Math.max(0, t.start - 30), t.start);
  const v = t.value;
  let lo: number | null = v;
  let hi: number | null = v;
  if (MAX_ONLY_RX.test(before)) lo = null;
  else if (MIN_ONLY_RX.test(before) || text[t.end] === '+') hi = null;
  return { start: t.start, end: t.end, lo, hi, cur: t.cur, isRange: false, gapPeriod: null };
}

const DOLLAR_COUNTRY: Record<string, string> = { us: 'USD', ca: 'CAD', au: 'AUD', nz: 'NZD', sg: 'SGD', hk: 'HKD' };
const DOLLAR_MENTIONS: [RegExp, string][] = [
  [/\bUSD\b|\bUS dollars?\b|\bU\.S\. dollars?\b/i, 'USD'],
  [/\bCAD\b|\bCanadian dollars?\b/i, 'CAD'],
  [/\bAUD\b|\bAustralian dollars?\b/i, 'AUD'],
  [/\bNZD\b|\bNew Zealand dollars?\b/i, 'NZD'],
  [/\bSGD\b|\bSingapore dollars?\b/i, 'SGD'],
  [/\bHKD\b|\bHong Kong dollars?\b/i, 'HKD'],
];

/**
 * Resolve a bare `$`. Order: a single dollar currency named anywhere in the text,
 * then a single dollar country in the job location. Anything else is ambiguous
 * (USD vs CAD vs AUD differ by 25-35%), so it stays unresolved.
 */
function resolveDollar(text: string, hints: SalaryHints): string | null {
  const mentioned = DOLLAR_MENTIONS.filter(([rx]) => rx.test(text)).map(([, c]) => c);
  if (mentioned.length === 1) return mentioned[0]!;
  if (mentioned.length > 1) return null;
  const countries = new Set<string>();
  for (const key of placesIn(hints.location)) {
    const code = DOLLAR_COUNTRY[key.split(':')[0]!];
    if (code) countries.add(code);
  }
  return countries.size === 1 ? [...countries][0]! : null;
}

interface Candidate {
  lo: number | null;
  hi: number | null;
  currency: string;
  period: SalaryPeriod;
  score: number;
}

/**
 * Extract an annual salary range from free text, or null.
 *
 * Accepts only a figure with an explicit currency marker (symbol, ISO code,
 * lakh/LPA) that sits next to a pay cue word ("salary", "pay range", "base",
 * "compensation", "OTE"), or a range with an explicit period. Rejects bonus,
 * equity, stipend, relocation, funding and revenue money, implausible
 * magnitudes, and amounts whose period is missing and that are too small to be
 * annual. Periods are normalised to annual (ANNUAL_FACTOR).
 *
 * Choices: a bare `$` that cannot be tied to one country returns null rather
 * than a currency-less amount (L1 would ignore it anyway, and the UI would
 * show a number with no unit). OTE figures are accepted at the lowest cue
 * priority: for the L1 floor an OTE that is below the floor means base is too,
 * so the error can only keep a job, never drop one. When the accepted figures
 * differ (per-location tiers, base vs OTE) the envelope over all of them is
 * returned, or null when it is more than 2.5x wide.
 */
export function extractSalaryFromText(text: string, hints: SalaryHints = {}): ExtractedSalary | null {
  if (!text) return null;
  const src = text.replace(/[\u00A0\u2007\u2009\u200B\u202F]/g, ' ');
  const toks = tokenize(src);
  if (toks.length === 0) return null;

  const candidates: Candidate[] = [];
  let dollar: string | null | undefined;

  for (let i = 0; i < toks.length; i++) {
    const first = i;
    const t1 = toks[i]!;
    const t2 = toks[i + 1];
    let expr: Expr | null = null;
    if (t2) {
      const pair = pairExpr(src, t1, t2);
      if (pair === 'reject') {
        i++;
        continue;
      }
      if (pair) {
        expr = pair;
        i++;
      }
    }
    expr ??= singleExpr(src, t1);
    if (!expr) continue;
    // "$250k OTE ($60.10/hour)": a parenthesised figure straight after another one
    // restates it in another unit, so it is not a second pay claim.
    const prev = toks[first - 1];
    if (prev && expr.start - prev.end <= 25 && /\(\s*$/.test(src.slice(Math.max(0, expr.start - 3), expr.start))) continue;

    const before = src.slice(Math.max(0, expr.start - 140), expr.start);
    const scope = figureScope(before);
    if (OTHER_ROLE_RX.test(scope)) continue;
    const afterPeriod = periodAt(src, expr.end);
    const lpa = toks.slice(i - (expr.isRange ? 1 : 0), i + 1).some((t) => t.suffix === 'lpa');
    const explicit = afterPeriod?.period ?? expr.gapPeriod ?? (lpa ? 'year' : null);
    const period = explicit ?? periodBefore(before);

    // "$20,000 per year bonus": the noun after the period phrase still names the money.
    const afterEnd = afterPeriod ? expr.end + afterPeriod.len : expr.end;
    if (negativeAfter(src, afterEnd)) continue;
    if (negativeBefore(scope)) continue;

    const cue = Math.max(cueAfter(src, afterEnd), cueBefore(scope));
    const selfDescribing = lpa;
    if (cue === 0 && !(expr.isRange && explicit) && !selfDescribing) continue;

    let currency = expr.cur;
    if (currency === '$') {
      dollar ??= resolveDollar(src, hints);
      if (!dollar) continue;
      currency = dollar;
    }
    if (!currency || !ANNUAL_BOUNDS[currency]) continue;

    const eff: SalaryPeriod = period ?? 'year';
    const lo = expr.lo == null ? null : annualize(expr.lo, eff);
    const hi = expr.hi == null ? null : annualize(expr.hi, eff);
    // Unknown period reads as annual only when the figure is a plausible annual one.
    if ([lo, hi].some((n) => n != null && !plausibleAnnual(n, currency, period != null))) continue;

    candidates.push({
      lo,
      hi,
      currency,
      period: eff,
      score: cue + (explicit ? 0.5 : 0) + (expr.isRange ? 0.25 : 0),
    });
  }

  if (candidates.length === 0) return null;
  // Never let one candidate win on score alone: a perk or side figure that slipped
  // through would then replace the real salary. All accepted candidates are folded
  // into one envelope, which only ever errs towards keeping a job at the L1 floor.
  const first = candidates.reduce((a, b) => (b.score > a.score ? b : a));
  if (candidates.some((c) => c.currency !== first.currency)) return null;

  const distinct = new Set(candidates.map((c) => `${c.lo}|${c.hi}`));
  if (distinct.size === 1) return { min: first.lo, max: first.hi, currency: first.currency, period: first.period };

  const los = candidates.map((c) => c.lo).filter((n): n is number => n != null);
  const his = candidates.map((c) => c.hi).filter((n): n is number => n != null);
  const min = los.length ? Math.min(...los) : null;
  const max = his.length ? Math.max(...his) : null;
  if (min != null && max != null && max / min > 2.5) return null;
  return { min, max, currency: first.currency, period: first.period };
}
