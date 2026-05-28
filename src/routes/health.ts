import { Hono } from 'hono';
import { db } from '../db/client';
import { llm } from '../llm';

export const health = new Hono();

health.get('/', async c => {
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
    const result = await llm.healthcheck();
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

  // Playwright check (just verify the chromium binary exists)
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    checks.playwright = { ok: true };
  } catch (err) {
    checks.playwright = { ok: false, detail: String(err) };
  }

  const allOk = Object.values(checks).every(c => c.ok);
  return c.json({ ok: allOk, checks }, allOk ? 200 : 503);
});
