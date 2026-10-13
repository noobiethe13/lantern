export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'internship', 'temporary'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

// Title markers on text already run through filter.ts's normalizeForMatch (lowercase,
// accents stripped, "-" "_" "/" read as spaces). \b keeps "intern" out of
// "International"/"Internal", and plurals ("Interns", "Contractors") are not matched
// because they name who a role serves, not the role's own engagement. Only
// unambiguous markers: "temp" and "PT" are left out (too many other readings).
//
// A marker followed by one of these nouns is the role's subject rather than its
// engagement type: "Intern Program Manager", "Contract Manager", "Contractor
// Payments Engineer", "Temporary Housing Coordinator". Skipping errs toward passing.
const SUBJECT_NOUN = [
  'program', 'programs', 'programme', 'recruiter', 'recruiters', 'recruiting', 'recruitment',
  'coordinator', 'coordinators', 'housing', 'worker', 'workers', 'staffing', 'payment', 'payments',
  'payroll', 'management', 'onboarding', 'compliance', 'experience', 'success', 'operations', 'ops',
  'marketplace', 'platform', 'network', 'relations', 'sourcing', 'engagement', 'hiring', 'lifecycle',
  'community', 'council', 'invoicing', 'portal',
  // Contract-as-document roles
  'manager', 'administrator', 'admin', 'specialist', 'analyst', 'negotiator', 'attorney', 'lawyer',
  'counsel', 'officer', 'review', 'drafter', 'associate', 'paralegal',
].join('|');

const marker = (words: string) => new RegExp(`\\b(?:${words})\\b(?!\\s+(?:${SUBJECT_NOUN})\\b)`);

const TITLE_MARKERS: [EmploymentType, RegExp][] = [
  ['internship', marker('intern|internship')],
  ['contract', marker('contract|contractor|freelance|freelancer')],
  ['part_time', /\bpart ?time\b/],
  ['full_time', /\bfull ?time\b/],
  ['temporary', marker('temporary')],
];

// "Part-time OK", "open to part-time": the title is offering an option, not stating
// the engagement, so it must not read as part-time-only.
const TYPE_WORDS = String.raw`part ?time|full ?time|contract|temporary|intern(?:ship)?`;
const OPTIONAL_MENTION = new RegExp(
  String.raw`\b(?:(?:ok|okay|open|flexible|considered|welcome)\s+(?:for|to|with)\s+)?(?:${TYPE_WORDS})\s+(?:ok|okay|possible|welcome|considered|available|friendly|negotiable)\b` +
    String.raw`|\b(?:ok|okay|open|flexible)\s+(?:for|to|with)\s+(?:${TYPE_WORDS})\b`,
  'g',
);

/** Employment types a (normalized) job title states outright. Empty when it says
 *  nothing, which the filter treats as "unknown, pass". */
export function employmentTypesInTitle(normalizedTitle: string): Set<EmploymentType> {
  const title = normalizedTitle.replace(OPTIONAL_MENTION, ' ');
  const out = new Set<EmploymentType>();
  for (const [type, re] of TITLE_MARKERS) if (re.test(title)) out.add(type);
  return out;
}

/** Map an ATS's structured commitment label (Lever "Full-time", Ashby "FullTime",
 *  "Intern") to an EmploymentType, or undefined for anything unrecognised. */
export function normalizeEmploymentLabel(label: unknown): EmploymentType | undefined {
  if (typeof label !== 'string') return undefined;
  const s = label.toLowerCase().replace(/[^a-z]+/g, '');
  if (s === 'fulltime') return 'full_time';
  if (s === 'parttime') return 'part_time';
  if (s === 'intern' || s === 'internship') return 'internship';
  if (s === 'contract' || s === 'contractor' || s === 'freelance') return 'contract';
  if (s === 'temporary' || s === 'temp') return 'temporary';
  return undefined;
}
