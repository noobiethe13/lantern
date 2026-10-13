import { Hono } from 'hono';
import { z } from 'zod';
import { zodErrorBody } from '../server/errors';
import {
  boardRefresher,
  readBoardRefreshSettings,
  writeBoardRefreshSettings,
} from '../runner/board-refresher';

export const boardRefreshSettings = new Hono();

// The background refresher keeps enabled company boards fresh so searches are served from the
// board cache (runner/board-refresher.ts). GET carries the live status for the Settings panel.
const BoardRefreshSettingsSchema = z.object({ enabled: z.boolean() });

boardRefreshSettings.get('/', c =>
  c.json({ settings: readBoardRefreshSettings(), status: boardRefresher.getStatus() }),
);

boardRefreshSettings.put('/', async c => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = BoardRefreshSettingsSchema.safeParse(body);
  if (!parsed.success) return c.json(zodErrorBody(parsed.error), 400);

  writeBoardRefreshSettings(parsed.data);
  boardRefresher.notifySettingsChanged();
  return c.json({ ok: true, settings: parsed.data, status: boardRefresher.getStatus() });
});
