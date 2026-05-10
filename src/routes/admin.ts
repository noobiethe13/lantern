import { Hono } from 'hono';
import { db } from '../db/client';

export const admin = new Hono();

// Wipes all scan results — jobs, runs, attachments.
// Sources and criteria are user config, not scan data — preserved.
admin.post('/clear-jobs', c => {
  db.run('DELETE FROM attachments');
  db.run('DELETE FROM jobs');
  db.run('DELETE FROM runs');

  // Reset source scan metadata so status dots go back to "never"
  db.run('UPDATE sources SET last_scan_at = NULL, last_status = NULL, last_error = NULL');

  return c.json({ ok: true, msg: 'All jobs, runs, and attachments cleared.' });
});
