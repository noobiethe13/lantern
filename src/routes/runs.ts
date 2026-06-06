import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import yaml from 'js-yaml';
import { db } from '../db/client';
import { bus, type ScanEvent } from '../runner/progress';
import { runFull, getScanningState } from '../runner/scan';
import { llm } from '../llm';
import { NLFilterShape } from '../llm/schemas';
import { nlFilterPrompt } from '../llm/prompts';

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

// Distinct recent search queries for the search-box dropdown. Registered before
// /:id so Hono doesn't capture "recent-queries" as an id.
runs.get('/recent-queries', c => {
  const rows = db.query<{ query: string }, []>(
    `SELECT query FROM runs
     WHERE query IS NOT NULL AND TRIM(query) != ''
     GROUP BY query
     ORDER BY MAX(started_at) DESC
     LIMIT 5`
  ).all();
  return c.json({ queries: rows.map(r => r.query) });
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

  const body = await c.req.json().catch(() => ({}));
  const query = typeof body?.query === 'string' ? body.query.trim() : '';

  // When the search carries a natural-language query, interpret it into the
  // structured criteria via Claude BEFORE the scan starts (the runner reads the
  // criteria for L1/L2). Criteria is a derived artifact here — not user-edited.
  // Regenerating it invalidates prior verdicts (scored against the old rubric).
  // `interpreted` is returned so the UI can show "here's what Lantern understood".
  let interpreted: unknown = null;
  if (query) {
    try {
      const prompt = nlFilterPrompt(query);
      const result = await llm.call({ task: 'nl-filter', prompt }, NLFilterShape);
      interpreted = result;
      const yamlStr = yaml.dump(result, { lineWidth: 120 });
      const now = Date.now();
      db.run(
        `INSERT INTO criteria (id, yaml, source_text, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET yaml = excluded.yaml, source_text = excluded.source_text, updated_at = excluded.updated_at`,
        [yamlStr, query, now]
      );
      db.run('UPDATE jobs SET l2_verdict_json = NULL, l2_score = NULL, l2_fit = NULL WHERE l2_verdict_json IS NOT NULL');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Could not interpret your search: ${msg}` }, 502);
    }
  }

  // Start the scan in the background (don't await). Progress goes through
  // the bus directly — there's no longer a parallel onEvent callback.
  runFull(query || undefined).catch(err => {
    console.error('[scan] unhandled error:', err);
  });

  // We need the run_id — it gets created in runScan and emitted on the bus.
  // Return a response right after the scan is kicked off; the client polls
  // GET /api/runs to find the latest run_id and then opens the SSE stream.
  return c.json({ ok: true, msg: 'Scan started', criteria: interpreted }, 202);
});
