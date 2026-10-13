import { describe, expect, test } from 'bun:test';
import { annualize, annualizePay, extractSalaryFromText, periodFromLabel, type ExtractedSalary, type SalaryHints } from './salary';

const US: SalaryHints = { location: 'Remote - US' };

type Want = ExtractedSalary | null;

describe('extractSalaryFromText: positives', () => {
  test.each<[string, string, SalaryHints, Want]>([
    ['usd range per year', 'The salary range for this role is $150,000 - $190,000 per year.', US,
      { min: 150000, max: 190000, currency: 'USD', period: 'year' }],
    ['trailing USD code, no hint', 'Pay range: $150,000 - $190,000 USD', {},
      { min: 150000, max: 190000, currency: 'USD', period: 'year' }],
    ['EUR k range with en dash', 'Base salary: €70k–€85k', {},
      { min: 70000, max: 85000, currency: 'EUR', period: 'year' }],
    ['GBP "to" and per annum', 'Salary £55,000 to £65,000 per annum', {},
      { min: 55000, max: 65000, currency: 'GBP', period: 'year' }],
    ['INR LPA range', 'CTC: ₹25-35 LPA', {},
      { min: 2500000, max: 3500000, currency: 'INR', period: 'year' }],
    ['INR single LPA', 'Salary 25 LPA', {},
      { min: 2500000, max: 2500000, currency: 'INR', period: 'year' }],
    ['INR lakh grouping', 'Salary: ₹25,00,000 - ₹35,00,000 per year', {},
      { min: 2500000, max: 3500000, currency: 'INR', period: 'year' }],
    ['lakh words with cue', 'Salary: INR 18-24 lakh', {},
      { min: 1800000, max: 2400000, currency: 'INR', period: 'year' }],
    ['hourly range annualised x2080', 'Hourly rate: $60 - $75 per hour', US,
      { min: 124800, max: 156000, currency: 'USD', period: 'hour' }],
    ['cents survive until annualisation', 'Compensation range (hourly rate of $43.48 - $54.36)', US,
      { min: 90438, max: 113069, currency: 'USD', period: 'hour' }],
    ['slash hr', 'Pay: $60-$75/hr', US, { min: 124800, max: 156000, currency: 'USD', period: 'hour' }],
    ['CAD code prefix', 'Salary: CAD 120k', {}, { min: 120000, max: 120000, currency: 'CAD', period: 'year' }],
    ['European thousands dot', 'Salary: 85.000 – 95.000 €', {},
      { min: 85000, max: 95000, currency: 'EUR', period: 'year' }],
    ['plus means open-ended', 'Salary: $150k+', US, { min: 150000, max: null, currency: 'USD', period: 'year' }],
    ['up to is max only', 'Salary up to $200,000', US, { min: null, max: 200000, currency: 'USD', period: 'year' }],
    ['starting at is min only', 'Salary starting at $90,000', US,
      { min: 90000, max: null, currency: 'USD', period: 'year' }],
    ['AUD prefix', 'Salary A$150,000 - A$180,000 plus super', {},
      { min: 150000, max: 180000, currency: 'AUD', period: 'year' }],
    ['monthly x12', 'Monthly salary: €4,500 per month', {}, { min: 54000, max: 54000, currency: 'EUR', period: 'month' }],
    ['daily x260', 'Day rate £300–£400 per day', {}, { min: 78000, max: 104000, currency: 'GBP', period: 'day' }],
    ['single figure', 'Salary: $120,000', US, { min: 120000, max: 120000, currency: 'USD', period: 'year' }],
    ['repeated identical range is one', 'Salary $120,000 - $140,000 per year.\nAgain: salary $120,000 - $140,000 per year.', US,
      { min: 120000, max: 140000, currency: 'USD', period: 'year' }],
    ['per-location tiers give the envelope',
      'SF salary $180,000 - $220,000 per year. NYC salary $170,000 - $210,000 per year.', US,
      { min: 170000, max: 220000, currency: 'USD', period: 'year' }],
    ['OTE accepted when it is all there is', 'OTE $200,000', US,
      { min: 200000, max: 200000, currency: 'USD', period: 'year' }],
    ['base and OTE fold into an envelope', 'Base salary $100,000 - $120,000. OTE $200,000 with commission.', US,
      { min: 100000, max: 200000, currency: 'USD', period: 'year' }],
    ['perk with a period does not outrank salary: bonus', 'Base salary $150,000, plus $20,000 per year bonus', US,
      { min: 150000, max: 150000, currency: 'USD', period: 'year' }],
    ['perk with a period does not outrank salary: stipend', 'Salary $150,000 plus $2,500 per month stipend', US,
      { min: 150000, max: 150000, currency: 'USD', period: 'year' }],
    ['contractor rate in another sentence is out of scope', 'The salary is $180,000 - $220,000. For contractors: $45/hour.', US,
      { min: 180000, max: 220000, currency: 'USD', period: 'year' }],
    ['budget with a period is not pay', 'Salary $120,000. You will manage a $50,000 per year budget.', US,
      { min: 120000, max: 120000, currency: 'USD', period: 'year' }],
    ['INR with a lakh-scale amount and no period', 'Salary: ₹8,00,000', {},
      { min: 800000, max: 800000, currency: 'INR', period: 'year' }],
    ['uppercase K', 'Compensation: $150K–$190K', US, { min: 150000, max: 190000, currency: 'USD', period: 'year' }],
    ['swiss apostrophe grouping', "Salary CHF 110'000 – 130'000", {},
      { min: 110000, max: 130000, currency: 'CHF', period: 'year' }],
    ['space after symbol', 'Salary range $ 150,000 - $ 190,000', US,
      { min: 150000, max: 190000, currency: 'USD', period: 'year' }],
    ['em dash, no spaces', 'Pay range $150,000—$190,000 USD', {},
      { min: 150000, max: 190000, currency: 'USD', period: 'year' }],
    ['between ... and', 'Annual salary between $120,000 and $150,000', US,
      { min: 120000, max: 150000, currency: 'USD', period: 'year' }],
    ['shared k suffix', 'Salary $150-190k', US, { min: 150000, max: 190000, currency: 'USD', period: 'year' }],
    ['bonus excluded, salary kept', 'A bonus of $10,000 and salary of $120,000', US,
      { min: 120000, max: 120000, currency: 'USD', period: 'year' }],
    ['equity before salary cue', 'Equity and salary range of $130,000 - $160,000', US,
      { min: 130000, max: 160000, currency: 'USD', period: 'year' }],
    ['base then amount', 'Base: $140,000 - $170,000', US, { min: 140000, max: 170000, currency: 'USD', period: 'year' }],
    ['heading on previous line', 'Salary Range\n$150,000 - $190,000', US,
      { min: 150000, max: 190000, currency: 'USD', period: 'year' }],
    ['million suffix', 'Salary $1.2M', US, { min: 1200000, max: 1200000, currency: 'USD', period: 'year' }],
    ['plus bonus after salary', 'Salary $150,000 + bonus', US,
      { min: 150000, max: 150000, currency: 'USD', period: 'year' }],
    ['plus sign beside bonus after period', 'Base salary $150,000 per year plus bonus', US,
      { min: 150000, max: 150000, currency: 'USD', period: 'year' }],
    ['parenthesised restatement is not a second claim', 'Compensation: $250k OTE ($60.10/hour) in New York City', US,
      { min: 250000, max: 250000, currency: 'USD', period: 'year' }],
    ['mxn with a dollar sign', 'Monthly Pay Range $43,500 — $48,333 MXN', {},
      { min: 522000, max: 579996, currency: 'MXN', period: 'month' }],
    ['wide but real range', 'Annual Salary: $280,000 — $850,000 USD', {},
      { min: 280000, max: 850000, currency: 'USD', period: 'year' }],
    ['bare dollar via single USD mention', 'Salary $150,000 - $190,000. All figures are in USD.', {},
      { min: 150000, max: 190000, currency: 'USD', period: 'year' }],
  ])('%s', (_name, text, hints, want) => {
    expect(extractSalaryFromText(text, hints)).toEqual(want);
  });
});

describe('extractSalaryFromText: bare dollar resolution', () => {
  const body = 'Salary: $100,000 - $120,000';
  test.each<[string, SalaryHints, string | null]>([
    ['US city', { location: 'Austin, TX' }, 'USD'],
    ['Canada', { location: 'Toronto, Canada' }, 'CAD'],
    ['Australia', { location: 'Sydney' }, 'AUD'],
    ['Singapore', { location: 'Singapore' }, 'SGD'],
    ['New Zealand', { location: 'Auckland' }, 'NZD'],
    ['plain Remote is ambiguous', { location: 'Remote' }, null],
    ['US or Canada is ambiguous', { location: 'Remote (US or Canada)' }, null],
    ['UK location does not make a dollar', { location: 'London' }, null],
    ['no hint', {}, null],
  ])('%s', (_name, hints, currency) => {
    expect(extractSalaryFromText(body, hints)?.currency ?? null).toBe(currency);
  });

  test('two dollar codes in the text stay ambiguous even with a US location', () => {
    expect(
      extractSalaryFromText('Salary $100,000 - $120,000. Canadian roles are paid in CAD, US roles in USD.', { location: 'Boston, MA' }),
    ).toBeNull();
  });

  test('explicit non-dollar symbols never need a hint', () => {
    expect(extractSalaryFromText('Salary £50,000 - £60,000', { location: 'Austin, TX' })?.currency).toBe('GBP');
  });
});

describe('extractSalaryFromText: negatives', () => {
  test.each<[string, string, SalaryHints]>([
    ['funding round', 'We raised $50M in Series B funding.', US],
    ['funding with salary elsewhere', 'Competitive salary. We have raised $50M from top investors.', US],
    ['signing bonus', 'Competitive salary. $10,000 signing bonus.', US],
    ['401k match', 'Salary and benefits include 401k match up to $6,000.', US],
    ['learning budget', 'Salary plus a $1,000 learning budget per year.', US],
    ['a year number', 'Founded in 2026, we are growing fast.', US],
    ['implausible annual', 'Salary: $2,026', US],
    ['bonus amount', 'Annual bonus of up to $20,000 on top of salary.', US],
    ['relocation', 'Salary is competitive. $1,500 relocation stipend.', US],
    ['revenue', 'Our ARR passed $200M and our salary bands are fair.', US],
    ['no cue, single figure', 'Our customers save $500,000 a year on average.', US],
    ['hourly sized figure with unknown period', 'Pay: $45', US],
    ['monthly sized figure with unknown period', 'Salary €3,500', {}],
    ['equity range', 'Equity worth $100,000 - $200,000 over four years.', US],
    ['conflicting currencies', 'Salary £55,000 - €65,000', {}],
    ['reversed range', 'Salary $190,000 - $150,000', US],
    ['two dollar codes, no location', 'Salary $100,000 - $120,000 (USD for US roles, CAD for Canada).', {}],
    ['no currency marker', 'Salary: 150000 - 190000', US],
    ['range with no cue and no period', 'Remote | $150k-$190k | Full-time', US],
    ['experience years', 'Salary negotiable. 5-7 years of experience required.', US],
    ['empty', '', US],
    ['too-wide multiple tiers', 'Salary $50,000 - $70,000 per year. Salary $200,000 - $250,000 per year.', US],
    ['deal sizes', 'You will close deals between $100,000 and $400,000.', US],
    ['stipend', 'Pay includes a monthly stipend of $400', US],
    ['budget with a period, no real salary', 'You will manage a $50,000 per year budget. Competitive salary.', US],
    ['other role in a multi-role post', 'Also hiring: Customer Support, salary $45k-$55k/yr', US],
    ['INR monthly-looking figure with no period', 'Salary: ₹1,50,000', {}],
    ['weekly stipend in three currencies', 'Compensation\n\nThe expected base stipend for this role is 3,850 USD / 2,310 GBP / 4,300 CAD per week', {}],
    ['fellowship annualisation claim', 'Compensation: $100,000–$167,000 USD for the four-month fellowship (equivalent to $300,000–$500,000 USD annualized)', {}],
    ['assets under management', 'Carta manages $250B+ in assets. We offer a competitive salary.', US],
  ])('%s', (_name, text, hints) => {
    expect(extractSalaryFromText(text, hints)).toBeNull();
  });
});

describe('period helpers', () => {
  test('annualize uses the documented factors', () => {
    expect(annualize(50, 'hour')).toBe(104000);
    expect(annualize(300, 'day')).toBe(78000);
    expect(annualize(1000, 'week')).toBe(52000);
    expect(annualize(5000, 'month')).toBe(60000);
    expect(annualize(90000, 'year')).toBe(90000);
  });

  test.each([
    ['per-year-salary', 'year'], ['1 YEAR', 'year'], ['YEARLY', 'year'], ['annual', 'year'],
    ['per-hour-wage', 'hour'], ['HOURLY', 'hour'], ['1 HOUR', 'hour'],
    ['per-month-salary', 'month'], ['MONTH', 'month'], ['weekly', 'week'], ['1 DAY', 'day'],
    ['NONE', null], ['', null],
  ])('periodFromLabel(%s)', (label, want) => {
    expect(periodFromLabel(label)).toBe(want as never);
  });

  test.each(['SEMI_MONTHLY', 'semi-monthly', 'BIWEEKLY', 'bi-weekly', '2 WEEK', '0.5 MONTH', 'fortnightly'])(
    'periodFromLabel rejects the part-period label %s',
    (label) => {
      expect(periodFromLabel(label)).toBeNull();
    },
  );

  test('a single-unit multiplier is still read', () => {
    expect(periodFromLabel('1 WEEK')).toBe('week');
  });

  test('annualizePay applies the floor to annual figures too', () => {
    expect(annualizePay(60, 80, 'per-year-salary', 'USD')).toBeNull();
    expect(annualizePay(60000, 80000, 'per-year-salary', 'USD')).toEqual({ min: 60000, max: 80000 });
    expect(annualizePay(60, 80, 'per-year-salary', 'XYZ')).toEqual({ min: 60, max: 80 });
  });

  test('annualizePay converts, passes annual through, rejects unknown', () => {
    expect(annualizePay(30, 45, 'HOURLY')).toEqual({ min: 62400, max: 93600 });
    expect(annualizePay(4000, null, 'per-month-salary')).toEqual({ min: 48000, max: null });
    expect(annualizePay(90000, 120000, 'YEARLY')).toEqual({ min: 90000, max: 120000 });
    expect(annualizePay(90000, 120000, 'NONE')).toBeNull();
    expect(annualizePay(0, null, 'YEARLY')).toBeNull();
  });
});

describe('extractSalaryFromText: cost', () => {
  const timed = (text: string) => {
    const t0 = performance.now();
    extractSalaryFromText(text, US);
    return performance.now() - t0;
  };

  test('long runs of lakh-grouped digits stay linear', () => {
    expect(timed('Salary ' + '1,11,'.repeat(1600))).toBeLessThan(150);
  });

  test('thousands of figures stay fast', () => {
    expect(timed('Salary range ' + '$1,000 '.repeat(1200))).toBeLessThan(400);
  });
});
