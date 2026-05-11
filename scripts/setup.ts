/**
 * bun run setup — interactive first-run wizard
 * Spec §13: checks prerequisites, creates data dirs, seeds DB, optional X login.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const ATTACHMENTS_DIR = join(DATA_DIR, 'attachments');
const PROFILE_DIR = join(DATA_DIR, 'browser-profile');

// ── helpers ────────────────────────────────────────────────────────────────

function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string) { console.error(`  ✗ ${msg}`); }
function info(msg: string) { console.log(`  ${msg}`); }
function step(n: number, msg: string) { console.log(`\n[${n}] ${msg}`); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

async function confirm(question: string): Promise<boolean> {
  const ans = await ask(`${question} [y/N] `);
  return ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes';
}

// ── step 1: check gemini ───────────────────────────────────────────────────

async function checkGeminiCli(): Promise<boolean> {
  step(1, 'Checking Gemini CLI…');
  const proc = Bun.spawn(['gemini', '--version'], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  if (code === 0) {
    ok(`gemini found: ${out.trim().slice(0, 60)}`);
    return true;
  }
  fail('gemini not found on PATH');
  info('Install with:');
  info('  npm i -g @google/gemini-cli');
  info('  gemini auth');
  return false;
}

// ── step 2: test gemini auth ───────────────────────────────────────────────

async function testGeminiAuth(): Promise<boolean> {
  step(2, 'Testing Gemini auth…');
  try {
    const proc = Bun.spawn(
      ['gemini', '--model', 'gemini-2.5-flash', '--yolo'],
      {
        stdin: new TextEncoder().encode('Reply with the single word: pong'),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const timeoutId = setTimeout(() => proc.kill('SIGTERM'), 30_000);
    const code = await proc.exited;
    clearTimeout(timeoutId);
    if (code === 0) {
      ok('Gemini auth OK');
      return true;
    }
    const err = await new Response(proc.stderr).text();
    fail(`Gemini auth failed (exit ${code}): ${err.slice(0, 120)}`);
    info('Run: gemini auth');
    return false;
  } catch (err) {
    fail(`Gemini spawn error: ${err}`);
    return false;
  }
}

// ── step 3: install playwright ────────────────────────────────────────────

async function installPlaywright(): Promise<boolean> {
  step(3, 'Installing Playwright chromium…');
  try {
    const proc = Bun.spawn(['bun', 'x', 'playwright', 'install', 'chromium'], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const code = await proc.exited;
    if (code === 0) { ok('Playwright chromium installed'); return true; }
    fail(`playwright install exited ${code}`);
    info('Try manually: bunx playwright install chromium');
    return false;
  } catch (err) {
    fail(`playwright install error: ${err}`);
    return false;
  }
}

// ── step 4: create data dirs ──────────────────────────────────────────────

function createDataDirs() {
  step(4, 'Creating data directories…');
  for (const dir of [DATA_DIR, ATTACHMENTS_DIR, PROFILE_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      ok(`created ${dir}`);
    } else {
      ok(`exists ${dir}`);
    }
  }
}

// ── step 5: DB migration ──────────────────────────────────────────────────

async function runMigrations() {
  step(5, 'Running DB migrations…');
  // Import triggers migrations in the db singleton
  const { db } = await import('../src/db/client');
  db.query('SELECT 1').get(); // smoke-test
  ok(`DB ready at ${join(DATA_DIR, 'data.db')}`);
  return db;
}

// ── step 6: seed sources ──────────────────────────────────────────────────

async function seedSources(db: import('bun:sqlite').Database) {
  step(6, 'Seeding sources from seed-sources.yml…');
  interface SeedSource {
    type: string;
    identifier: string;
    display_name: string;
    enabled: boolean;
  }
  const seedPath = join(ROOT, 'src/config/seed-sources.yml');
  const raw = yaml.load(readFileSync(seedPath, 'utf-8')) as { sources: SeedSource[] };
  const insert = db.prepare(
    'INSERT OR IGNORE INTO sources (type, identifier, display_name, enabled, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const now = Date.now();
  let count = 0;
  for (const s of raw.sources) {
    const result = insert.run(s.type, s.identifier, s.display_name, s.enabled ? 1 : 0, now);
    if ((result as unknown as { changes: number }).changes > 0) count++;
  }
  ok(`${count} new sources seeded (${raw.sources.length} total in seed file)`);
}

// ── step 7: optional X/Grok login ────────────────────────────────────────

async function configureXGrok(db: import('bun:sqlite').Database) {
  step(7, 'X/Grok login (optional)');
  const wantXGrok = await confirm('Configure X/Grok login now? (requires manual login in browser)');
  if (!wantXGrok) {
    info('Skipping — you can run setup again later or add the x-grok source via the UI.');
    return;
  }

  info('Launching headed browser at x.com/login — please log in manually, then close the window.');

  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 800 },
    });

    const page = await browser.newPage();
    await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

    info('Waiting for login (up to 5 minutes)…');
    const deadline = Date.now() + 5 * 60 * 1000;
    let loggedIn = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000);
      const url = page.url();
      if (url.includes('x.com/home') || url.includes('twitter.com/home')) {
        loggedIn = true;
        break;
      }
    }

    await page.close();
    await browser.close();

    if (loggedIn) {
      ok('X login successful — session saved to data/browser-profile/');
      // Ensure x-grok source exists in DB
      db.run(
        `INSERT OR IGNORE INTO sources (type, identifier, display_name, enabled, created_at)
         VALUES ('x-grok', 'x-grok', 'X/Grok', 1, ?)`,
        [Date.now()],
      );
      ok('x-grok source added');
    } else {
      fail('Login not detected within 5 minutes — skipping x-grok setup');
    }
  } catch (err) {
    fail(`X login error: ${err}`);
  }
}

// ── step 8: initial criteria ──────────────────────────────────────────────

async function setupCriteria(db: import('bun:sqlite').Database) {
  step(8, 'Initial search criteria');
  const existing = db.query<{ id: number }, []>('SELECT id FROM criteria WHERE id = 1').get();
  if (existing) {
    info('Criteria already configured — skipping (edit in the UI at /settings).');
    return;
  }

  info('Type what you\'re looking for (e.g. "mid-senior TypeScript remote $120k+")');
  info('Press Enter twice to skip and use the default criteria from src/config/search.yml');
  const userText = await ask('Criteria: ');

  if (!userText) {
    const { readFileSync } = await import('node:fs');
    const fallback = readFileSync(join(ROOT, 'src/config/search.yml'), 'utf-8');
    db.run(
      'INSERT OR REPLACE INTO criteria (id, yaml, source_text, updated_at) VALUES (1, ?, ?, ?)',
      [fallback, null, Date.now()],
    );
    info('Using default criteria from src/config/search.yml');
    return;
  }

  info('Converting to structured filter via Gemini Flash…');
  const { callGeminiValidated } = await import('../src/llm/gemini');
  const { NLFilterShape } = await import('../src/llm/schemas');
  const { nlFilterPrompt } = await import('../src/llm/prompts');

  try {
    const filter = await callGeminiValidated(
      { model: 'gemini-2.5-flash', prompt: nlFilterPrompt(userText) },
      NLFilterShape,
    );
    const criteriaYaml = (await import('js-yaml')).dump(filter);
    db.run(
      'INSERT OR REPLACE INTO criteria (id, yaml, source_text, updated_at) VALUES (1, ?, ?, ?)',
      [criteriaYaml, userText, Date.now()],
    );
    ok('Criteria saved');
    info(`\n${criteriaYaml}`);
  } catch (err) {
    fail(`Gemini criteria conversion failed: ${err}`);
    info('You can set criteria later via the UI at /settings');
  }
}

// ── main ───────────────────────────────────────────────────────────────────

console.log('\nlantern — setup wizard\n' + '─'.repeat(40));

let proceed = true;

const geminiOk = await checkGeminiCli();
if (!geminiOk) {
  const cont = await confirm('\nGemini CLI not found. Continue setup anyway?');
  if (!cont) { rl.close(); process.exit(1); }
}

const authOk = geminiOk ? await testGeminiAuth() : false;
if (geminiOk && !authOk) {
  info('You can run `gemini auth` then re-run setup, or continue without auth.');
}

await installPlaywright();
createDataDirs();

const db = await runMigrations();
await seedSources(db);
await configureXGrok(db);
await setupCriteria(db);

console.log('\n' + '─'.repeat(40));
console.log('lantern setup complete!');
console.log('\nNext steps:');
console.log('  bun start          — build UI and serve on localhost:3000');
console.log('  bun run scan       — one-shot scan from CLI');
console.log('  bun run healthcheck — verify all systems');

rl.close();
db.close?.();
