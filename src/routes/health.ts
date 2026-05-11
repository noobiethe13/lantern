import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db/client';

export const health = new Hono();

health.get('/', async c => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // DB check
  try {
    db.query('SELECT 1').get();
    checks.db = { ok: true };
  } catch (err) {
    checks.db = { ok: false, detail: String(err) };
  }

  // Gemini CLI check
  try {
    const proc = Bun.spawn(['gemini', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    checks.gemini = code === 0
      ? { ok: true, detail: out.trim().slice(0, 80) }
      : { ok: false, detail: `exit ${code}` };
  } catch (err) {
    checks.gemini = { ok: false, detail: String(err) };
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

  // Browser profile check
  const profileDir = join(process.cwd(), 'data', 'browser-profile');
  checks.browserProfile = existsSync(profileDir)
    ? { ok: true }
    : { ok: false, detail: 'data/browser-profile/ not found — run: bun run setup' };

  const allOk = Object.values(checks).every(c => c.ok);
  return c.json({ ok: allOk, checks }, allOk ? 200 : 503);
});
