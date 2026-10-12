import { describe, expect, test } from 'bun:test';
import {
  countryLevel,
  hasWorldwideMarker,
  placeLabel,
  placesForTerm,
  placesIn,
  placesOverlap,
  placesWithin,
} from './geo';

/** Countries (sub-national places lifted to their country) named in `text`. */
const countries = (text: string) => [...countryLevel(placesIn(text))].sort();

describe('placesIn — resolves free-text locations', () => {
  const cases: [string, string[]][] = [
    ['Bangalore', ['in']],
    ['Bengaluru - BLR1', ['in']],
    ['IN - Bengaluru', ['in']],
    ['Hyderabad', ['in']],
    ['Gurugram', ['in']],
    ['Pune/Pimpri-Chinchwad Area', ['in']],
    ['Mumbai Metropolitan Region', ['in']],
    ['Greater Chennai Area', ['in']],
    ['Hybrid - Bangalore', ['in']],
    ['Greater Lucknow Area', ['in']],
    ['Whitefield, Karnataka', ['in']],
    ['Gift City, Gandhinagar', ['in']],
    ['Indianapolis, IN', ['us']],
    ['Remote - Indianapolis, Indiana', ['us']],
    ['Austin, TX', ['us']],
    ['Remote - US', ['us']],
    ['United States - Remote', ['us']],
    ['San Francisco, CA, US; Remote, US', ['us']],
    ['Canada - Remote (ON, AB, BC, or NS Only)', ['ca']],
    ['Toronto, ON', ['ca']],
    ['Chennai, TN', ['in']], // TN is Tamil Nadu here, not Tennessee
    ['Perth, WA', ['au']], // WA is Western Australia here
    ['Kyiv, Ukraine', ['ua']],
    ['London, UK', ['gb']],
    ['São Paulo, Brazil', ['br']],
    ['Zürich', ['ch']],
    ['Kraków, Poland', ['pl']],
    ['Limassol, Cyprus', ['cy']],
    ['Remote (EMEA)', ['@emea']],
    ['APAC', ['@apac']],
    ['Australia, Canada, India, United Kingdom, United States', ['au', 'ca', 'gb', 'in', 'us']],
    // S-2: a same-named place colliding across countries defers to an explicit
    // trailing country segment ("City, Region, Country" shape).
    ['Hyderabad, Sindh, Pakistan', ['pk']],
    ['Surat Thani, Thailand', ['th']],
    ['Port of Spain', ['tt']], // not Spain
    // NCR alone (no "Delhi") is dropped — it collides with Metro Manila's own
    // National Capital Region.
    ['Makati City, NCR, Philippines', ['ph']],
  ];
  for (const [text, expected] of cases) {
    test(`"${text}" → ${expected.join(',')}`, () => {
      expect(countries(text)).toEqual(expected);
    });
  }
});

describe('placesIn — ambiguous tokens give no signal', () => {
  for (const text of [
    'Georgia', 'Jersey', 'Cambridge', 'Remote', 'Victoria', 'Punjab', 'Jordan',
    'in', 'ca', 'de', 'us', 'Join us', 'Business hours IST', 'Mauritius', '', 'Hybrid',
    // NCR bare / spelled out is ambiguous (Delhi NCR vs Metro Manila's own NCR) —
    // only "Delhi NCR" resolves (S-2).
    'NCR', 'National Capital Region',
  ]) {
    test(`"${text}" → none`, () => {
      expect(placesIn(text).size).toBe(0);
    });
  }

  test('lowercase codes in prose are words, uppercase codes are countries', () => {
    expect(placesIn('work with us').size).toBe(0);
    expect(countries('Remote, US')).toEqual(['us']);
  });

  test('a US postal code never fires without a comma-separated city position', () => {
    expect(placesIn('OR Hybrid').size).toBe(0);
    expect(countries('Portland, OR')).toEqual(['us']);
  });
});

describe('placesForTerm — criteria terms', () => {
  test('a term that is exactly a country code resolves in any case', () => {
    expect([...placesForTerm('us')]).toEqual(['us']);
    expect([...placesForTerm('uk')]).toEqual(['gb']);
    expect([...placesForTerm('USA')]).toEqual(['us']);
  });

  test('names, cities and regions', () => {
    expect([...placesForTerm('india')]).toEqual(['in']);
    expect([...countryLevel(placesForTerm('bangalore'))]).toEqual(['in']);
    expect([...placesForTerm('europe')]).toEqual(['@europe']);
    expect(placesForTerm('remote').size).toBe(0);
    expect(placesForTerm('in').size).toBe(0);
  });
});

describe('placesOverlap / placesWithin', () => {
  const overlap = (job: string, term: string) => placesOverlap(placesIn(job), placesForTerm(term));
  const within = (job: string, term: string) => placesWithin(placesIn(job), placesForTerm(term));

  const overlapCases: [string, string, boolean][] = [
    ['Bangalore', 'india', true],
    ['India', 'bangalore', true],
    ['APAC', 'india', true],
    ['Remote - South Asia', 'india', true],
    ['Germany', 'europe', true],
    ['Remote (EMEA)', 'germany', true],
    ['Remote (EU)', 'europe', true],
    ['Remote - US', 'india', false],
    ['Indianapolis, Indiana', 'india', false],
    ['Remote (EMEA)', 'india', false],
    ['Berlin', 'london', false],
    ['Manchester, UK', 'london', false], // the UK only qualifies Manchester
  ];
  for (const [job, term, expected] of overlapCases) {
    test(`overlap("${job}", "${term}") → ${expected}`, () => {
      expect(overlap(job, term)).toBe(expected);
    });
  }

  const withinCases: [string, string, boolean][] = [
    ['Austin, TX', 'united states', true],
    ['Remote (USA only)', 'us', true],
    ['Bangalore', 'india', true],
    ['APAC', 'india', false],
    ['Remote - Americas', 'united states', false],
    ['Remote - DACH', 'europe', true],
  ];
  for (const [job, term, expected] of withinCases) {
    test(`within("${job}", "${term}") → ${expected}`, () => {
      expect(within(job, term)).toBe(expected);
    });
  }
});

describe('hasWorldwideMarker', () => {
  for (const [text, expected] of [
    ['Remote — Worldwide', true],
    ['Anywhere', true],
    ['Remote (Global)', true],
    ['All locations', true],
    ['Remote - US', false],
    ['Global Payments HQ, London', true],
    ['Remote', false],
    ['', false],
    // "anywhere"/"all locations" name a country right next to the word — that
    // scopes them to that country, not the whole world (S-1).
    ['Anywhere, US', false],
    ['Anywhere USA', false],
    ['U.S. Anywhere', false],
    ['Remote - US: All locations', false],
    // ...but a region alone (no country) still counts as worldwide for this
    // rule's purposes — no single country is named to scope it to.
    ['Anywhere in APAC', true],
  ] as [string, boolean][]) {
    test(`"${text}" → ${expected}`, () => {
      expect(hasWorldwideMarker(text)).toBe(expected);
    });
  }
});

describe('placeLabel', () => {
  test('human-readable labels for countries and regions', () => {
    expect(placeLabel('us')).toBe('United States');
    expect(placeLabel('in')).toBe('India');
    expect(placeLabel('@emea')).toBe('EMEA');
    expect(placeLabel('ge')).toBe('Georgia');
  });
});
