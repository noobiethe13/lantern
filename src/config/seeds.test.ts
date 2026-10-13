import { test, expect, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

const WORK = join(import.meta.dir, '.seeds-test-cwd');
const ORIG_CWD = process.cwd();

mkdirSync(join(WORK, 'src/config'), { recursive: true });
writeFileSync(
  join(WORK, 'src/config/seed-sources.yml'),
  'sources:\n  - { type: greenhouse, identifier: Anthropic, display_name: "Anthropic", enabled: true }\n',
);
writeFileSync(
  join(WORK, 'src/config/discovered-sources.json'),
  JSON.stringify({
    generated: { note: 'fixture' },
    sources: [
      { type: 'ashby', identifier: 'found-co', display_name: 'Found Co', jobs: 4, verified_at: '2026-10-12' },
      { type: 'workday', identifier: 'not-discoverable', display_name: 'Nope', jobs: 1, verified_at: '2026-10-12' },
      { type: 'lever', identifier: '../escape', display_name: 'Escape', jobs: 1, verified_at: '2026-10-12' },
      { type: 'lever', identifier: 'no-name', jobs: 1, verified_at: '2026-10-12' },
    ],
  }),
);
process.chdir(WORK);

afterAll(() => {
  process.chdir(ORIG_CWD);
  rmSync(WORK, { recursive: true, force: true });
});

const { isSeededSource, loadDiscoveredSources } = await import('./seeds');

test('isSeededSource: matches (type, identifier) case-insensitively', () => {
  expect(isSeededSource('greenhouse', 'anthropic')).toBe(true);
  expect(isSeededSource('greenhouse', 'ANTHROPIC')).toBe(true);
  expect(isSeededSource('GREENHOUSE', 'Anthropic')).toBe(true);
});

test('isSeededSource: false for a user-added source not in the seed list', () => {
  expect(isSeededSource('greenhouse', 'some-random-user-added-co')).toBe(false);
  expect(isSeededSource('lever', 'anthropic')).toBe(false);
});

test('loadDiscoveredSources: keeps valid entries, skips invalid ones and non-discoverable types', () => {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => void warnings.push(m);
  try {
    expect(loadDiscoveredSources().map(s => `${s.type}:${s.identifier}`)).toEqual(['ashby:found-co']);
  } finally {
    console.warn = warn;
  }
  expect(warnings[0]).toContain('skipped 3 invalid entries');
});

test('loadDiscoveredSources: missing file means no discovered boards', () => {
  rmSync(join(WORK, 'src/config/discovered-sources.json'));
  expect(loadDiscoveredSources()).toEqual([]);
});
