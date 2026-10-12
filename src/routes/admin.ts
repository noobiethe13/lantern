import { Hono } from 'hono';
import { db } from '../db/client';
import { getScanningState } from '../runner/scan';
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

  const attachmentRows = db.query<{ stored_path: string }, []>('SELECT stored_path FROM attachments').all();
  db.run('DELETE FROM attachments');
  db.run('DELETE FROM jobs');
  db.run('DELETE FROM runs');

  // Reset source scan metadata so status dots go back to "never"
  db.run('UPDATE sources SET last_scan_at = NULL, last_status = NULL, last_error = NULL');

  for (const row of attachmentRows) unlinkAttachment(row.stored_path);

  return c.json({ ok: true, msg: 'All jobs, runs, and attachments cleared.' });
});
