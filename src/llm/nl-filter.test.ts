import { describe, expect, test } from 'bun:test';
import { nlFilterPrompt } from './prompts';
import { NLFilterShape } from './schemas';
import { zodToProviderSchema } from './zod-to-schema';

const base = {
  title: { positive: ['backend'], negative: [] },
  location: { remote_required: false, allowed: [], block: [], always_allow: [] },
  seniority: { allowed: [] },
  experience_years: null,
  salary_min_usd: null,
  salary_currency: 'USD',
  exclude_companies: [],
};

describe('NLFilterShape', () => {
  test('accepts a stated experience_years range', () => {
    const parsed = NLFilterShape.parse({ ...base, experience_years: { min: 1, max: 3 } });
    expect(parsed.experience_years).toEqual({ min: 1, max: 3 });
  });

  test('accepts null experience_years when unstated', () => {
    const parsed = NLFilterShape.parse({ ...base, experience_years: null });
    expect(parsed.experience_years).toBeNull();
  });

  test('trims and drops blank entries from every term list', () => {
    const parsed = NLFilterShape.parse({
      ...base,
      title: { positive: [' backend ', '', 'node'], negative: ['  '] },
      location: { remote_required: false, allowed: ['india', ' '], block: [''], always_allow: [] },
      exclude_companies: [' meta ', ''],
    });
    expect(parsed.title.positive).toEqual(['backend', 'node']);
    expect(parsed.title.negative).toEqual([]);
    expect(parsed.location.allowed).toEqual(['india']);
    expect(parsed.location.block).toEqual([]);
    expect(parsed.exclude_companies).toEqual(['meta']);
  });

  test('uppercases salary_currency', () => {
    const parsed = NLFilterShape.parse({ ...base, salary_currency: 'usd' });
    expect(parsed.salary_currency).toBe('USD');
  });

  test('the generated JSON schema includes experience_years', () => {
    const schema = zodToProviderSchema(NLFilterShape);
    const json = JSON.stringify(schema);
    expect(json).toContain('experience_years');
    const props = (schema as { properties?: Record<string, unknown> }).properties;
    expect(props?.experience_years).toBeDefined();
  });
});

describe('nlFilterPrompt', () => {
  test('the US block example does not include the bare word "us"', () => {
    const prompt = nlFilterPrompt('remote, not in the US');
    // The example array for the US block must not contain a bare "us" entry —
    // it collides with the pronoun once L1 does whole-word gazetteer matching.
    expect(prompt).not.toContain('"united states","usa","us"');
    expect(prompt).toContain('"united states","usa"');
  });

  test('location guidance tells the model to name countries, not cities', () => {
    const prompt = nlFilterPrompt('remote or in India');
    expect(prompt).not.toContain('"uk","united kingdom","england","london"');
    expect(prompt).toContain('remote or in India');
    expect(prompt).toContain('always_allow ["india"]');
  });

  test('documents the "remote or in <country>" pattern as remote_required false', () => {
    const prompt = nlFilterPrompt('remote or in India');
    expect(prompt).toContain('remote_required false');
  });

  test('warns against bare generic title terms', () => {
    const prompt = nlFilterPrompt('mobile engineer');
    expect(prompt).toContain('mobile developer');
    expect(prompt).toContain('whole-word');
  });

  test('includes the experience_years extraction rule with examples', () => {
    const prompt = nlFilterPrompt('1 to 3 years of experience');
    expect(prompt).toContain('experience_years');
    expect(prompt).toContain('"min":1,"max":3');
    expect(prompt).toContain('"min":5,"max":null');
  });
});
