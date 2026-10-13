import { Hono } from 'hono';
import { db } from '../db/client';
import { getScanningState } from '../runner/scan';
import { boardRefresher } from '../runner/board-refresher';
import { unlinkAttachment } from './attachments';

export const admin = new Hono();

// Wipes all scan results — jobs, runs, attachments.
// Sources and criteria are user config, not scan data — preserved.
admin.post('/clear-jobs', c => {
  // A scan in flight still holds the run row this clears; deleting it out from
  // under the scan means later progress updates hit nothing and the UI never
  // sees the run finish. Refuse while scanning, same as the resume-settings guard.
  if (getScanningState()) {
    return c.json({ error: 'A scan is in progress — wait for it to finish before clearing jobs' }, 409);
  }

  // A board mid-refresh would otherwise finish writing after the wipe and mark itself fresh
  // with only part of its jobs stored.
  boardRefresher.cancelInFlight();

  const attachmentRows = db.query<{ stored_path: string }, []>('SELECT stored_path FROM attachments').all();
  db.run('DELETE FROM attachments');
  db.run('DELETE FROM jobs');
  db.run('DELETE FROM runs');

  // Reset source scan metadata so status dots go back to "never"
  // last_ok_fetch_at too: the clear took every board's stored jobs and sightings with it, so a
  // board left "fresh" would be served from cache as empty until its TTL ran out.
  db.run('UPDATE sources SET last_scan_at = NULL, last_status = NULL, last_error = NULL, last_ok_fetch_at = NULL, refresh_failures = 0, refresh_retry_at = NULL');

  for (const row of attachmentRows) unlinkAttachment(row.stored_path);

  return c.json({ ok: true, msg: 'All jobs, runs, and attachments cleared.' });
});
