import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { health } from './routes/health';
import { jobs } from './routes/jobs';
import { sources } from './routes/sources';
import { runs } from './routes/runs';
import { attachments } from './routes/attachments';
import { admin } from './routes/admin';
import { llmSettings } from './routes/llm-settings';
import { resumeSettings } from './routes/resume';
import { embeddingSettings } from './routes/embeddings';
import { freshnessSettings } from './routes/freshness';
import { l2CapSettings } from './routes/l2-cap';
import { boardCacheSettings } from './routes/board-cache';
import { boardRefreshSettings } from './routes/board-refresh';
import { startBoardRefresher } from './runner/board-refresher';
import { recoverInterruptedScans } from './runner/scan';

// db import in routes triggers runMigrations via client.ts singleton

// A process killed mid-scan (crash, Ctrl+C, a `bun --watch` reload) can leave
// behind a scan_locks row and a run with finished_at still NULL; without this,
// every future search 409s forever and the Search page hangs on "Scanning" (L1
// in review notes). Safe to call unconditionally at startup — it only clears
// state a dead process left behind, never a lock this process itself just took.
recoverInterruptedScans();

// Warms stale company boards in the background after a short delay. Skipped when
// NODE_ENV=test (`bun test` sets it, and the shared test harness imports this file), so
// importing the app never starts background fetches.
if (process.env.NODE_ENV !== 'test') startBoardRefresher();

const app = new Hono();

// Host allowlist for every /api/* request (any method, any port — the Vite dev
// proxy uses changeOrigin so Host arrives as localhost:3000 regardless of which
// port the browser's page is actually on). Defends against DNS rebinding: a page
// can make the browser open a connection to 127.0.0.1 while the Host header still
// names the attacker's domain, since the browser sends Host based on the URL it
// believes it's fetching, not the IP it actually connected to. For state-changing
// requests, also reject a foreign Origin (or a declared cross-site fetch) — this
// is what actually blocks "simple"/no-cors cross-origin requests, which skip the
// preflight entirely and so aren't stopped by the cors() middleware below (that
// middleware only controls whether the BROWSER exposes the response to JS, not
// whether the request itself runs server-side).
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

function hostnameOf(hostHeader: string): string {
  // Host header is "hostname[:port]"; IPv6 literals are bracketed ("[::1]:3000").
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    return (end === -1 ? hostHeader : hostHeader.slice(1, end)).toLowerCase();
  }
  const colon = hostHeader.lastIndexOf(':');
  return (colon === -1 ? hostHeader : hostHeader.slice(0, colon)).toLowerCase();
}

app.use('/api/*', async (c, next) => {
  if (!ALLOWED_HOSTNAMES.has(hostnameOf(c.req.header('host') ?? ''))) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (c.req.header('sec-fetch-site') === 'cross-site') {
      return c.json({ error: 'forbidden' }, 403);
    }
    const origin = c.req.header('origin');
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return c.json({ error: 'forbidden' }, 403);
    }
  }

  await next();
});

// Allow Vite dev server to call the API during development
app.use('/api/*', cors({ origin: ['http://localhost:5173', 'http://localhost:3000'] }));

// API routes
app.route('/api/health', health);
app.route('/api/jobs', jobs);
app.route('/api/sources', sources);
app.route('/api/runs', runs);
app.route('/api/attachments', attachments);
app.route('/api/admin', admin);
app.route('/api/settings/llm', llmSettings);
app.route('/api/settings/resume', resumeSettings);
app.route('/api/settings/embeddings', embeddingSettings);
app.route('/api/settings/freshness', freshnessSettings);
app.route('/api/settings/l2-cap', l2CapSettings);
app.route('/api/settings/board-cache', boardCacheSettings);
app.route('/api/settings/board-refresh', boardRefreshSettings);

// Anything under /api/* that didn't match a route above (wrong method, unknown
// path) must 404 as JSON — registered after every real API route but before
// static serving, otherwise it fell through to the SPA fallback and came back as
// index.html with a 200.
app.all('/api/*', c => c.json({ error: 'not found' }, 404));

app.onError((err, c) => {
  console.error('[server] unhandled error:', err);
  return c.json({ error: 'internal error' }, 500);
});

// Serve the built Vite SPA — static files first, then fall through to index.html.
// GET only (Hono auto-derives HEAD from a registered GET) — a POST/PUT/DELETE to
// a non-API path has no business being answered with the SPA shell.
app.get('/*', serveStatic({ root: './ui/dist' }));
app.get('/*', serveStatic({ path: './ui/dist/index.html' }));

export default {
  port: 3000,
  hostname: 'localhost',
  // SSE scan-progress streams stay open for the whole run and can idle between
  // batched-L2 bursts; the default 10s idleTimeout would drop them mid-scan.
  // The stream also sends a 10s comment heartbeat (see routes/runs.ts) — this is
  // the backstop. (Bun caps idleTimeout at 255s.)
  idleTimeout: 255,
  fetch: app.fetch,
};
