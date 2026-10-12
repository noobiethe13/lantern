import { Hono } from 'hono';
import { db } from '../db/client';
import { llm } from '../llm';

export const health = new Hono();

health.get('/', async c => {
  // Cheap by default: CLI presence/version only. `?deep=1` additionally runs a
  // real model call — worth paying for on-demand, but never on every Settings
  // mount or mid-scan poll (see healthcheck's own comment for why that used to
  // stall SSE and running scans).
  const deep = c.req.query('deep') === '1';
  const checks: Record<string, { ok: boolean; detail?: string; deprecation?: string }> = {};

  // DB check
  try {
    db.query('SELECT 1').get();
    checks.db = { ok: true };
  } catch (err) {
    checks.db = { ok: false, detail: String(err) };
  }

  // LLM provider check — delegated to the active provider so health reflects
  // whichever backend the user has selected in Settings.
  try {
    const result = await llm.healthcheck({ deep });
    checks.llm = {
      ok: result.ok,
      detail: result.detail
        ? `${llm.providerName}: ${result.detail.slice(0, 80)}`
        : llm.providerName,
      ...(result.deprecation ? { deprecation: result.deprecation } : {}),
    };
  } catch (err) {
    checks.llm = { ok: false, detail: `${llm.providerName}: ${String(err)}` };
  }

  const allOk = Object.values(checks).every(c => c.ok);
  return c.json({ ok: allOk, checks }, allOk ? 200 : 503);
});
