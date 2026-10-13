import { db } from '../db/client';
import { discoveredSourcesFingerprint, loadDiscoveredSources } from '../config/seeds';

// Lives outside scan.ts so routes/sources.ts can seed on demand without importing the
// runner (which already imports that route module).

/**
 * Insert the verified-but-unreviewed boards from discovered-sources.json as
 * disabled, origin='discovered' rows. INSERT OR IGNORE only: an existing row
 * (seeded, user-added, or an earlier discovery the user has since toggled) is
 * never touched, and there is no retire/disable sync, so a board dropping out of
 * the file leaves its row alone. Skipped when the file's fingerprint matches the one
 * stored after the last successful seeding (and rows still exist), since the file
 * runs to thousands of entries and changes only when the script is rerun.
 */
export function seedDiscoveredSources(now: number): void {
  const fingerprint = discoveredSourcesFingerprint();
  if (fingerprint === null) return;
  const stored = db
    .query<{ value_json: string }, []>("SELECT value_json FROM settings WHERE key = 'discovered_seed_hash'")
    .get();
  if (stored && JSON.parse(stored.value_json) === fingerprint) {
    const rows = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sources WHERE origin = 'discovered'").get()!.n;
    if (rows > 0) return;
  }
  const entries = loadDiscoveredSources();
  if (entries.length === 0) return;
  const insert = db.prepare<unknown, [string, string, string, number]>(
    `INSERT OR IGNORE INTO sources (type, identifier, display_name, enabled, config_json, created_at, origin)
     VALUES (?, ?, ?, 0, NULL, ?, 'discovered')`
  );
  db.transaction(() => {
    for (const e of entries) insert.run(e.type, e.identifier, e.display_name, now);
    db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('discovered_seed_hash', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [JSON.stringify(fingerprint), now],
    );
  })();
}
