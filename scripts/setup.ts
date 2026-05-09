// First-run wizard — full implementation in Phase 5.
// For now just runs the DB migration so `bun run setup` is not broken.

import { db } from '../src/db/client';

console.log('lantern — setup');
console.log('DB initialized at data/data.db');
console.log('\nNext steps:');
console.log('  1. npm i -g @google/gemini-cli && gemini auth');
console.log('  2. bunx playwright install chromium');
console.log('  3. bun run scan       — test that adapters work');
console.log('  4. bun start          — start the web UI (after Phase 4)');

db.close?.();
