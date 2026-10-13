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
  employment_types: [],
  visa_sponsorship_required: false,
  skills: { must: [], nice: [] },
  industries: { include: [], exclude: [] },
  company_stage: [],
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

describe('NLFilterShape — intent fields', () => {
  test('accepts the full set of intent fields', () => {
    const parsed = NLFilterShape.parse({
      ...base,
      employment_types: ['contract', 'part_time'],
      visa_sponsorship_required: true,
      skills: { must: [' kubernetes '], nice: ['go', ''] },
      industries: { include: ['climate'], exclude: ['crypto', 'web3'] },
      company_stage: ['startup'],
    });
    expect(parsed.employment_types).toEqual(['contract', 'part_time']);
    expect(parsed.skills).toEqual({ must: ['kubernetes'], nice: ['go'] });
    expect(parsed.industries.exclude).toEqual(['crypto', 'web3']);
    expect(parsed.company_stage).toEqual(['startup']);
  });

  test('off-enum employment types and stages are dropped, not fatal', () => {
    const parsed = NLFilterShape.parse({
      ...base,
      employment_types: ['Contract', 'freelance', 'contract'],
      company_stage: ['startup', 'unicorn'],
    });
    expect(parsed.employment_types).toEqual(['contract']);
    expect(parsed.company_stage).toEqual(['startup']);
  });

  test('a pre-upgrade row without the intent fields fails to parse (so it regenerates)', () => {
    const { employment_types: _a, visa_sponsorship_required: _b, skills: _c, industries: _d, company_stage: _e, ...legacy } = base;
    expect(NLFilterShape.safeParse(legacy).success).toBe(false);
  });

  test('every intent field stays required in the emitted --json-schema', () => {
    const schema = zodToProviderSchema(NLFilterShape) as { required?: string[] };
    for (const k of ['employment_types', 'visa_sponsorship_required', 'skills', 'industries', 'company_stage']) {
      expect(schema.required).toContain(k);
    }
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

  test('documents the intent fields with examples', () => {
    const prompt = nlFilterPrompt('contract rust backend, must know kubernetes, no crypto, need visa sponsorship');
    expect(prompt).toContain('employment_types');
    expect(prompt).toContain('visa_sponsorship_required');
    expect(prompt).toContain('skills.must');
    expect(prompt).toContain('"no crypto" -> ["crypto"');
    expect(prompt).toContain('never bare function words');
    expect(prompt).toContain('company_stage');
    expect(prompt).toContain('NOT a request for full_time');
  });
});
