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
process.chdir(WORK);

afterAll(() => {
  process.chdir(ORIG_CWD);
  rmSync(WORK, { recursive: true, force: true });
});

const { isSeededSource } = await import('./seeds');

test('isSeededSource: matches (type, identifier) case-insensitively', () => {
  expect(isSeededSource('greenhouse', 'anthropic')).toBe(true);
  expect(isSeededSource('greenhouse', 'ANTHROPIC')).toBe(true);
  expect(isSeededSource('GREENHOUSE', 'Anthropic')).toBe(true);
});

test('isSeededSource: false for a user-added source not in the seed list', () => {
  expect(isSeededSource('greenhouse', 'some-random-user-added-co')).toBe(false);
  expect(isSeededSource('lever', 'anthropic')).toBe(false);
});
