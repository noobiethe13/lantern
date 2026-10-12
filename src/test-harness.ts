// Single shared bun:test harness for the WHOLE suite. Chdirs into a scratch cwd
// OUTSIDE the repo (client.ts / seeds.ts / attachments.ts all resolve data/ and
// src/config/*.yml from process.cwd(), and this file must never touch the real
// data/) then mocks db/client + llm/index BEFORE importing server.ts, so every
// route/runner module underneath is exercised against one real (migrated)
// :memory: db and one fake LLM, without a real database, the claude CLI, or a
// network listener.
//
// bun's mock.module is a process-global, last-registration-wins override, not a
// per-file sandbox: it rewrites the live `db`/`llm` binding for every existing
// and future `import` of those modules process-wide, including modules a given
// test file never imports itself (scan.ts's own db import, legitimacy.ts via
// scan.ts, etc — anything reachable from server.ts's import graph). This repo
// used to have THREE independent harnesses (this file, runner/test-db-harness.ts,
// routes/route-test-harness.ts), each registering its own mock db/llm for the
// same two modules — whichever file's mock.module call ran last silently
// repointed every other file's already-loaded db/llm consumers at its own
// throwaway instance mid-suite, corrupting unrelated tests. The fix is this
// file: ONE db (and one llm fake) mock, registered ONCE for the whole process,
// that every test file imports and shares. `resetDb()` (called from each
// consuming file's `beforeEach`) clears tables and re-arms the mocks instead of
// creating a new database, so tests stay isolated from each other without ever
// repointing the shared mock away from `memDb`.
import { mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export const REPO = join(import.meta.dir, '..').replace(/\\/g, '/');
export const WORK = join(tmpdir(), 'lantern-w1a-test-cwd').replace(/\\/g, '/');

rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(WORK, 'src/config'), { recursive: true });
writeFileSync(join(WORK, 'src/config/seed-sources.yml'), 'sources: []\n');
writeFileSync(join(WORK, 'src/config/search.yml'), readFileSync(join(REPO, 'src/config/search.yml'), 'utf-8'));
mkdirSync(join(WORK, 'ui/dist'), { recursive: true });
writeFileSync(join(WORK, 'ui/dist/index.html'), '<!doctype html><html><body>SPA-INDEX</body></html>');
process.chdir(WORK);

const { runMigrations } = await import(`${REPO}/src/db/migrate.ts`);
export const memDb = new Database(':memory:');
memDb.run('PRAGMA foreign_keys = ON');
runMigrations(memDb);

export type LlmReq = { task: string; prompt: string; timeoutMs?: number };
export const llmCalls: LlmReq[] = [];
const NOT_CONFIGURED = async (): Promise<never> => {
  throw new Error('llm not configured');
};
export let llmImpl: (req: LlmReq, schema: { parse: (x: unknown) => unknown }) => Promise<unknown> = NOT_CONFIGURED;
export function setLlm(fn: typeof llmImpl): void {
  llmImpl = fn;
}
const fakeLlm = {
  __isMock: true,
  async call(req: LlmReq, schema: { parse: (x: unknown) => unknown }) {
    llmCalls.push(req);
    return schema.parse(await llmImpl(req, schema));
  },
  async healthcheck() {
    return { ok: true, detail: 'mock' };
  },
  get providerName() {
    return 'mock';
  },
};

function armDb(): void {
  mock.module(`${REPO}/src/db/client.ts`, () => ({ db: memDb }));
}
function armLlm(): void {
  mock.module(`${REPO}/src/llm/index.ts`, () => ({ llm: fakeLlm, resetLlmCache() {} }));
}
armDb();
armLlm();

export const server = (await import(`${REPO}/src/server.ts`)).default as {
  fetch: (r: Request) => Promise<Response>;
};

const llmMod = await import(`${REPO}/src/llm/index.ts`);
if (!(llmMod.llm as { __isMock?: boolean }).__isMock) throw new Error('LLM MOCK NOT APPLIED — aborting');
if (existsSync(join(WORK, 'data'))) throw new Error('DB MOCK NOT APPLIED (real client.ts ran) — aborting');
const dbMod = await import(`${REPO}/src/db/client.ts`);
if (dbMod.db !== memDb) throw new Error('db mock identity mismatch');

export const { bus } = await import(`${REPO}/src/runner/progress.ts`);
export const scan = await import(`${REPO}/src/runner/scan.ts`);
export const { runs } = await import(`${REPO}/src/routes/runs.ts`);

export const NL_OK = {
  title: { positive: ['engineer'], negative: [] },
  location: { remote_required: false, allowed: [], block: [], always_allow: [] },
  seniority: { allowed: [] },
  experience_years: null,
  salary_min_usd: null,
  salary_currency: 'USD',
  exclude_companies: [],
};

/** Hits the full server (with the Host/Origin middleware, 404 catch-all, etc). A
 * real HTTP client always sends a Host header (added by the transport layer); a
 * synthetic Request built in-process does not, so this defaults one to a
 * legitimate value — tests that exercise the Host allowlist override it
 * explicitly. */
export function req(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('host')) headers.set('host', 'localhost:3000');
  return server.fetch(new Request(`http://localhost:3000${path}`, { ...init, headers }));
}

/** Embeddings default to enabled, which would otherwise load the real local ML
 * model — every test that reaches runFull/runL2Pass must turn it off first. */
export function seedEmbeddingsOff(): void {
  memDb.run(
    `INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES ('embeddings', '{"enabled":false}', 0)`
  );
}

export function insertSource(overrides: Record<string, unknown> = {}): number {
  const cols = {
    type: 'greenhouse',
    identifier: `acme${Math.random().toString(36).slice(2)}`,
    display_name: 'Acme',
    enabled: 0,
    created_at: 0,
    ...overrides,
  };
  const keys = Object.keys(cols);
  return memDb
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- column set is dynamic per call site
    .query<{ id: number }, any[]>(
      `INSERT INTO sources (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) RETURNING id`
    )
    .get(...Object.values(cols))!.id;
}

export function insertJob(sourceId: number, extra: Record<string, unknown> = {}): number {
  const n = Math.random().toString(36).slice(2);
  const cols = {
    source_id: sourceId,
    url: `https://x.test/${n}`,
    title: 'Engineer',
    company: 'Acme',
    company_norm: 'acme',
    content_hash: n,
    first_seen: 1,
    last_seen: 1,
    ...extra,
  };
  const keys = Object.keys(cols);
  return memDb
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- column set is dynamic per call site
    .query<{ id: number }, any[]>(
      `INSERT INTO jobs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) RETURNING id`
    )
    .get(...Object.values(cols))!.id;
}

/**
 * Full reset, called from every consuming test file's `beforeEach`. Two jobs at
 * once: (1) per-test isolation — this is ONE shared db for the whole suite, not
 * one per file, so every mutable table needs clearing between tests, not just
 * runs/jobs/locks (a leftover enabled `sources` row from another file, for
 * instance, used to make a later scan test issue a real HTTP fetch); and
 * (2) re-arming the db/llm mocks (see the file-header note) in case another
 * file's own mock.module call repointed them since the last test.
 */
export function resetDb(): void {
  armDb();
  armLlm();
  memDb.run('DELETE FROM scan_locks');
  memDb.run('DELETE FROM jobs'); // cascades attachments (ON DELETE CASCADE)
  memDb.run('DELETE FROM sources');
  memDb.run('DELETE FROM runs');
  memDb.run('DELETE FROM criteria');
  memDb.run('DELETE FROM settings');
  llmCalls.length = 0;
  llmImpl = NOT_CONFIGURED;
}
