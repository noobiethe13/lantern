import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db } from '../db/client';
import { bus, type ScanEvent } from '../runner/progress';
import { runFull, getScanningState } from '../runner/scan';

export const runs = new Hono();

runs.get('/', c => {
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);
  const rows = db.query<Record<string, unknown>, [number]>(
    `SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`
  ).all(limit);
  return c.json({ runs: rows.map(r => ({
    ...r,
    errors: r.errors_json ? JSON.parse(r.errors_json as string) : [],
    errors_json: undefined,
  })) });
});

runs.get('/:id', c => {
  const row = db.query<Record<string, unknown>, [number]>(
    'SELECT * FROM runs WHERE id = ?'
  ).get(Number(c.req.param('id')));
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({
    ...row,
    errors: row.errors_json ? JSON.parse(row.errors_json as string) : [],
    errors_json: undefined,
  });
});

runs.get('/:id/stream', c => {
  const runId = Number(c.req.param('id'));

  return streamSSE(c, async stream => {
    // Send a heartbeat immediately so the client knows the connection is alive
    await stream.writeSSE({ data: JSON.stringify({ type: 'connected', runId }), event: 'message' });

    const run = db.query<{ finished_at: number | null }, [number]>(
      'SELECT finished_at FROM runs WHERE id = ?'
    ).get(runId);

    // If run is already finished, send synthetic done and close
    if (run?.finished_at) {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'done', msg: 'Run already completed', runId }),
        event: 'message',
      });
      return;
    }

    await new Promise<void>(resolve => {
      const unsub = bus.subscribe(runId, async (event: ScanEvent) => {
        await stream.writeSSE({
          data: JSON.stringify(event),
          event: 'message',
        });
        if (event.type === 'done' || event.type === 'error' || event.type === 'l2_done') {
          unsub();
          resolve();
        }
      });

      // Clean up if the client disconnects
      stream.onAbort(() => {
        unsub();
        resolve();
      });

      // Safety timeout — 30 min max
      setTimeout(() => {
        unsub();
        resolve();
      }, 30 * 60 * 1000);
    });
  });
});

runs.post('/scan', async c => {
  if (getScanningState()) {
    return c.json({ error: 'A scan is already running' }, 409);
  }

  // Start the scan in the background (don't await). Progress goes through
  // the bus directly — there's no longer a parallel onEvent callback.
  runFull().catch(err => {
    console.error('[scan] unhandled error:', err);
  });

  // We need the run_id — it gets created in runScan and emitted on the bus.
  // Return a response right after the scan is kicked off; the client polls
  // GET /api/runs to find the latest run_id and then opens the SSE stream.
  return c.json({ ok: true, msg: 'Scan started' }, 202);
});
