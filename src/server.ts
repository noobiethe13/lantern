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

// db import in routes triggers runMigrations via client.ts singleton

const app = new Hono();

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

// Serve the built Vite SPA — static files first, then fall through to index.html
app.use('/*', serveStatic({ root: './ui/dist' }));
app.use('/*', serveStatic({ path: './ui/dist/index.html' }));

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
