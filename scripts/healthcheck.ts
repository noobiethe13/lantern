import { existsSync } from 'fs';
import { join } from 'path';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];

// 1. Bun version
checks.push({ name: 'Bun runtime', ok: true, detail: Bun.version });

// 2. gemini CLI on PATH
try {
  const proc = Bun.spawnSync(['gemini', '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode === 0) {
    checks.push({
      name: 'Gemini CLI',
      ok: true,
      detail: new TextDecoder().decode(proc.stdout).trim(),
    });
  } else {
    checks.push({
      name: 'Gemini CLI',
      ok: false,
      detail: 'not found — run: npm i -g @google/gemini-cli && gemini auth',
    });
  }
} catch {
  checks.push({
    name: 'Gemini CLI',
    ok: false,
    detail: 'not found — run: npm i -g @google/gemini-cli && gemini auth',
  });
}

// 3. Playwright chromium installed
const playwrightBrowsers = join(
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.cache', 'ms-playwright'),
  'chromium*'
);
const pwCheck = (() => {
  try {
    // Try running playwright --version
    const proc = Bun.spawnSync(['bunx', 'playwright', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
})();
checks.push({
  name: 'Playwright',
  ok: pwCheck,
  detail: pwCheck ? 'installed' : 'run: bunx playwright install chromium',
});

// 4. DB writable
const dataDir = join(process.cwd(), 'data');
try {
  const { Database } = await import('bun:sqlite');
  const testDb = new Database(join(dataDir, 'data.db'), { create: true });
  testDb.run('SELECT 1');
  testDb.close();
  checks.push({ name: 'SQLite DB', ok: true, detail: join(dataDir, 'data.db') });
} catch (err) {
  checks.push({
    name: 'SQLite DB',
    ok: false,
    detail: err instanceof Error ? err.message : String(err),
  });
}

// 5. browser-profile present (X/Grok login)
const profileDir = join(process.cwd(), 'data', 'browser-profile');
checks.push({
  name: 'Browser profile (X login)',
  ok: existsSync(profileDir),
  detail: existsSync(profileDir)
    ? profileDir
    : 'not set up — run bun run setup to configure',
});

// Print results
console.log('\nlantern — healthcheck\n');
let allOk = true;
for (const c of checks) {
  const icon = c.ok ? '✓' : '✗';
  console.log(`  ${icon}  ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  if (!c.ok) allOk = false;
}
console.log();

if (!allOk) {
  console.log('Some checks failed. See details above.\n');
  process.exit(1);
} else {
  console.log('All checks passed.\n');
}
