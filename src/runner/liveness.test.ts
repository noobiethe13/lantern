import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// `chromium.launch()` + `browser.newContext()` — always. The persistent-context
// call was removed with x-grok (MAC-3). This test asserts no production code
// re-introduces it. Test files themselves are excluded from the scan.
describe('no Playwright persistent context in src/', () => {
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
    test(`${file.replace(/\\/g, '/')} does not call the banned API`, () => {
      const src = readFileSync(file, 'utf8');
      // The string we're searching for — split to avoid this file matching itself
      expect(src).not.toContain('launch' + 'PersistentContext');
    });
  }
});
