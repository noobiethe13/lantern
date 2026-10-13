import { db } from '../db/client';
import { reserveCall, type RemotiveBudgetStore } from './remotive';

const BUDGET_SETTINGS_KEY = 'remotive_budget';

function readTimestamps(): number[] {
  const row = db
    .query<{ value_json: string }, [string]>('SELECT value_json FROM settings WHERE key = ?')
    .get(BUDGET_SETTINGS_KEY);
  if (!row) return [];
  const parsed: unknown = JSON.parse(row.value_json);
  return Array.isArray(parsed) ? parsed.filter((t): t is number => typeof t === 'number') : [];
}

// A single immediate transaction: bun:sqlite runs it synchronously, so no other
// reservation (another Remotive row in the same scan pool) can interleave
// between the read and the write.
const reserveTx = db.transaction((now: number, gapMs: number) => {
  const { result, timestamps } = reserveCall(readTimestamps(), now, gapMs);
  if (result.status === 'ok') {
    db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [BUDGET_SETTINGS_KEY, JSON.stringify(timestamps), now],
    );
  }
  return result;
});

/** Remotive call ledger in the settings KV (`remotive_budget`: epoch-ms list). */
export const settingsBudgetStore: RemotiveBudgetStore = {
  reserve: (now, gapMs) => reserveTx.immediate(now, gapMs),
};
