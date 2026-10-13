import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WORK, memDb, scan, resetDb } from '../test-harness';

const SEED_PATH = join(WORK, 'src/config/seed-sources.yml');
const DISCOVERED_PATH = join(WORK, 'src/config/discovered-sources.json');

function writeDiscovered(ids: [string, string][]): void {
  writeFileSync(
    DISCOVERED_PATH,
    JSON.stringify({
      generated: {},
      sources: ids.map(([type, identifier]) => ({
        type, identifier, display_name: identifier.toUpperCase(), jobs: 3, verified_at: '2026-10-12',
      })),
    }),
  );
}

type Row = { enabled: number; origin: string | null; display_name: string };
const row = (type: string, identifier: string): Row | null =>
  memDb.query<Row, [string, string]>(
    'SELECT enabled, origin, display_name FROM sources WHERE type = ? AND identifier = ?',
  ).get(type, identifier);

beforeEach(() => resetDb());

afterEach(() => {
  writeFileSync(SEED_PATH, 'sources: []\n');
  rmSync(DISCOVERED_PATH, { force: true });
});

test('discovered boards seed disabled and tagged', () => {
  writeDiscovered([['ashby', 'found-co'], ['lever', 'other-co']]);
  scan.seedSources();
  expect(row('ashby', 'found-co')).toEqual({ enabled: 0, origin: 'discovered', display_name: 'FOUND-CO' });
  expect(row('lever', 'other-co')?.enabled).toBe(0);
});

test('re-seeding never touches an existing row, whoever owns it', () => {
  writeDiscovered([['ashby', 'toggled']]);
  scan.seedSources();
  memDb.run("UPDATE sources SET enabled = 1 WHERE identifier = 'toggled'");
  memDb.run(
    "INSERT INTO sources (type, identifier, display_name, enabled, created_at) VALUES ('lever', 'userlever', 'User Lever', 1, 0)",
  );
  writeDiscovered([['ashby', 'toggled'], ['lever', 'userlever']]);
  scan.seedSources();
  expect(row('ashby', 'toggled')?.enabled).toBe(1);
  expect(row('lever', 'userlever')).toEqual({ enabled: 1, origin: null, display_name: 'User Lever' });
});

test('a board dropping out of the file is not retired', () => {
  writeDiscovered([['ashby', 'found-co']]);
  scan.seedSources();
  memDb.run("UPDATE sources SET enabled = 1 WHERE identifier = 'found-co'");
  writeDiscovered([]);
  scan.seedSources();
  expect(row('ashby', 'found-co')?.enabled).toBe(1);
});

test('a seed-list entry with the same slug wins over a discovered one', () => {
  writeFileSync(
    SEED_PATH,
    'sources:\n  - { type: ashby, identifier: both-co, display_name: "Both Co", enabled: true }\n',
  );
  writeDiscovered([['ashby', 'both-co']]);
  scan.seedSources();
  expect(row('ashby', 'both-co')).toEqual({ enabled: 1, origin: null, display_name: 'Both Co' });
});

test('promoting an already-seeded discovered board into the seed list adopts and enables it', () => {
  writeDiscovered([['ashby', 'promoted-co']]);
  scan.seedSources();
  expect(row('ashby', 'promoted-co')?.origin).toBe('discovered');
  writeFileSync(
    SEED_PATH,
    'sources:\n  - { type: ashby, identifier: promoted-co, display_name: "Promoted Co", enabled: true }\n',
  );
  scan.seedSources();
  expect(row('ashby', 'promoted-co')?.enabled).toBe(1);
  expect(row('ashby', 'promoted-co')?.origin).toBeNull();
});

test('a retired seed (enabled: false) leaves discovered boards alone', () => {
  writeDiscovered([['ashby', 'found-co']]);
  writeFileSync(
    SEED_PATH,
    'sources:\n  - { type: ashby, identifier: gone-co, display_name: "Gone", enabled: false }\n',
  );
  scan.seedSources();
  expect(row('ashby', 'found-co')?.origin).toBe('discovered');
  expect(row('ashby', 'found-co')?.enabled).toBe(0);
});

test('a case-variant seed entry adopts the discovered row and does not add a second enabled one', () => {
  writeDiscovered([['ashby', 'Case-Co']]);
  scan.seedSources();
  writeFileSync(
    SEED_PATH,
    'sources:\n  - { type: ashby, identifier: case-co, display_name: "Case Co", enabled: true }\n',
  );
  scan.seedSources();
  const rows = memDb.query<{ identifier: string; enabled: number; origin: string | null }, []>(
    "SELECT identifier, enabled, origin FROM sources WHERE lower(identifier) = 'case-co'",
  ).all();
  expect(rows).toEqual([{ identifier: 'Case-Co', enabled: 1, origin: null }]);
});
