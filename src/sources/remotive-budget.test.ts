import { beforeEach, describe, expect, test } from 'bun:test';
import { memDb, resetDb } from '../test-harness';

// Dynamic: a static import would evaluate db/client before the harness's top-level
// await has armed its mock.
const { settingsBudgetStore } = await import('./remotive-budget');

beforeEach(() => resetDb());

const NOW = Date.parse('2026-10-12T12:00:00Z');

describe('settingsBudgetStore', () => {
  test('persists reservations in the settings KV and stops at 4 per rolling 24h', () => {
    const results = Array.from({ length: 5 }, () => settingsBudgetStore.reserve(NOW, 0).status);
    expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'exhausted']);
    const row = memDb.query<{ value_json: string }, []>("SELECT value_json FROM settings WHERE key = 'remotive_budget'").get();
    expect(JSON.parse(row!.value_json)).toEqual([NOW, NOW, NOW, NOW]);
  });

  test('enforces the gap against the persisted newest timestamp', () => {
    expect(settingsBudgetStore.reserve(NOW, 31_000).status).toBe('ok');
    expect(settingsBudgetStore.reserve(NOW + 5_000, 31_000)).toEqual({ status: 'wait', waitMs: 26_000 });
    expect(settingsBudgetStore.reserve(NOW + 31_000, 31_000).status).toBe('ok');
  });
});
