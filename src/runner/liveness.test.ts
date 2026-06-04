import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Playwright / headless browsing was removed entirely in Phase 8. Liveness is
// fetch-only (HTTP + cheerio). This test asserts no production code re-introduces
// a Playwright dependency. Test files themselves are excluded from the scan.
describe('no Playwright usage in src/', () => {
  function collectTsFiles(dir: string): string[] {
    const entries = readdirSync(dir);
    return entries.flatMap(entry => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return collectTsFiles(full);
      if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !entry.endsWith('.test.ts')) {
        return [full];
      }
      return [];
    });
  }

  const srcDir = join(import.meta.dir, '..'); // src/
  const files = collectTsFiles(srcDir);

  for (const file of files) {
    test(`${file.replace(/\\/g, '/')} does not import playwright`, () => {
      const src = readFileSync(file, 'utf8');
      // Split to avoid this file matching itself.
      expect(src).not.toContain("'play" + "wright'");
      expect(src).not.toContain('"play' + 'wright"');
    });
  }
});
