import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import yaml from 'js-yaml';
import { db } from '../db/client';
import { bus, type ScanEvent } from '../runner/progress';
import { runFull, createRun, tryAcquireScanLock, releaseScanLock, type RunSetup } from '../runner/scan';
import { llm } from '../llm';
import { NLFilterShape } from '../llm/schemas';
import { nlFilterPrompt } from '../llm/prompts';

export const runs = new Hono();

// `limit` is user input straight into a LIMIT bind parameter — a non-numeric or
// fractional value used to reach bun:sqlite as-is and throw SQLITE_MISMATCH (500).
// Clamp to a sane integer range instead; anything that isn't a finite number
// falls back to the default rather than erroring.
function clampLimit(raw: string | undefined, def = 20, min = 1, max = 100): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

runs.get('/', c => {
  const limit = clampLimit(c.req.query('limit'));
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
  const known = Number.isInteger(runId)
    && db.query<{ id: number }, [number]>('SELECT id FROM runs WHERE id = ?').get(runId) !== null;
  if (!known) return c.json({ error: 'run not found' }, 404);

  return streamSSE(c, async stream => {
    let finished = false;
    let heartbeat: ReturnType<typeof setInterval>;
    let resolveWait: (() => void) | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      unsub();
      resolveWait?.();
    };

    // Register cleanup BEFORE any await — a client that disconnects while the
    // very first writeSSE below is still in flight must still release the
    // subscriber/heartbeat instead of leaking them for the life of the process.
    stream.onAbort(finish);

    const unsub = bus.subscribe(runId, async (event: ScanEvent) => {
      await stream.writeSSE({ data: JSON.stringify(event), event: 'message' });
      if (event.type === 'done' || event.type === 'error' || event.type === 'l2_done') finish();
    });

    // Send a heartbeat immediately so the client knows the connection is alive
    await stream.writeSSE({ data: JSON.stringify({ type: 'connected', runId }), event: 'message' });
    if (stream.aborted) return finish();

    const already = db.query<{ finished_at: number | null }, [number]>(
      'SELECT finished_at FROM runs WHERE id = ?'
    ).get(runId);
    if (already?.finished_at) {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'done', msg: 'Run already completed', runId }),
        event: 'message',
      });
      return finish();
    }
    if (finished) return; // a bus event or onAbort already fired while we awaited above

    // Hono 4.12's StreamingApi#write/writeSSE swallow write errors instead of
    // rejecting (see node_modules/hono/dist/utils/stream.js), so a `.catch()` here
    // never observes a dead connection. Poll `stream.aborted` plus the run's own
    // finished_at on every heartbeat tick as the reliable close signal instead. No
    // fixed time cap — a real long L2 run must keep streaming to completion rather
    // than being cut off mid-scan with no terminal event.
    await new Promise<void>(resolve => {
      if (finished) return resolve();
      resolveWait = resolve;
      heartbeat = setInterval(() => {
        if (stream.aborted) return finish();
        const run = db.query<{ finished_at: number | null }, [number]>(
          'SELECT finished_at FROM runs WHERE id = ?'
        ).get(runId);
        if (run?.finished_at) {
          stream.writeSSE({ data: JSON.stringify({ type: 'done', msg: 'Run completed', runId }), event: 'message' });
          return finish();
        }
        stream.write(': heartbeat\n\n');
      }, 10_000);
    });
  });
});

runs.post('/scan', async c => {
  // Acquire the lock BEFORE the (multi-second) nl-filter call and before writing
  // criteria, not after — otherwise two overlapping searches can both pass the
  // 409 check, and the loser overwrites criteria / wipes verdicts out from under
  // the run that's actually executing (L3 in review notes).
  if (!tryAcquireScanLock()) {
    return c.json({ error: 'A scan is already running' }, 409);
  }

  // A blank body is a plain re-scan of the existing criteria (CLAUDE.md contract),
  // not a 400 — only a non-blank, unparseable body is malformed JSON.
  let body: unknown;
  try {
    const text = await c.req.text();
    body = text.trim() ? JSON.parse(text) : {};
  } catch {
    releaseScanLock();
    return c.json({ error: 'Malformed JSON body' }, 400);
  }
  const rawQuery = (body as { query?: unknown } | null)?.query;
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (query.length > 500) {
    releaseScanLock();
    return c.json({ error: 'Query is too long (max 500 characters)' }, 400);
  }

  // When the search carries a natural-language query, interpret it into the
  // structured criteria via Claude BEFORE the scan starts (the runner reads the
  // criteria for L1/L2). Criteria is a derived artifact here — not user-edited.
  // An IDENTICAL query reuses the stored criteria as-is: no nl-filter call, no
  // verdict invalidation, so an L2 pass cut short by a usage limit can resume
  // instead of restarting from scratch (L4). A different query that nl-filter
  // still maps to the SAME structured criteria (a rephrase) also keeps verdicts —
  // only an actual rubric change invalidates them. `interpreted` is returned so
  // the UI can show "here's what Lantern understood".
  let interpreted: unknown = null;
  let setup: RunSetup;
  try {
    if (query) {
      const existing = db
        .query<{ yaml: string; source_text: string | null }, []>(
          'SELECT yaml, source_text FROM criteria WHERE id = 1'
        )
        .get();

      // Reuse the stored criteria only for an IDENTICAL query, and only when it
      // still parses against the current NLFilterShape — a pre-upgrade row (e.g.
      // missing the now-required-nullable experience_years) must regenerate via
      // nl-filter rather than being reused (or 500ing) as-is.
      let existingParsed: unknown;
      try {
        existingParsed = existing ? yaml.load(existing.yaml) : undefined;
      } catch {
        existingParsed = undefined;
      }
      const reusable =
        existing != null && existing.source_text === query && NLFilterShape.safeParse(existingParsed).success;

      if (reusable) {
        interpreted = existingParsed;
      } else {
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
          // L2 now grades on the query text too (source_text), not just the
          // structured criteria — a REPHRASED query that nl-filter still maps to
          // identical YAML must still invalidate verdicts, since the prompt they'd
          // be reused against has changed. Reaching this branch already means the
          // query differs from the stored source_text (or there is none), so
          // invalidate unconditionally rather than gating on a YAML diff.
          db.run('UPDATE jobs SET l2_verdict_json = NULL, l2_score = NULL, l2_fit = NULL WHERE l2_verdict_json IS NOT NULL');
        } catch (err) {
          releaseScanLock();
          const msg = err instanceof Error ? err.message : String(err);
          return c.json({ error: `Could not interpret your search: ${msg}` }, 502);
        }
      }
    }

    setup = createRun(query || undefined);
  } catch (err) {
    releaseScanLock();
    throw err;
  }

  // Start the scan in the background (don't await) — runFull owns the
  // already-acquired lock from here and releases it in its own finally,
  // however the scan ends. Progress goes through the bus directly.
  runFull(setup).catch(err => {
    console.error('[scan] unhandled error:', err);
  });

  return c.json({ ok: true, msg: 'Scan started', criteria: interpreted, runId: setup.runId }, 202);
});
