import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The deterministic browser tier (ADR 0003) scopes — rather than lifts — the old
// "no headless browser anywhere" rule. The engine is an OPTIONAL dependency loaded
// ONLY via a dynamic import() inside the single seam src/runner/browser.ts. No
// other production file may name or statically import a browser engine, and the
// seam itself must not static-import it (a static import would make a default
// install pull/load the browser). This test enforces that isolation so the bulk
// fetch path stays browser-free by construction. (.test.ts files are excluded.)
describe('browser engine is isolated to the lazy seam', () => {
  function collectTsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap(entry => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return collectTsFiles(full);
      if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !entry.endsWith('.test.ts')) return [full];
      return [];
    });
  }

  const srcDir = join(import.meta.dir, '..'); // src/
  const SEAM_SUFFIX = 'src/runner/browser.ts';
  // Split so this test file never matches itself when scanned by other tooling.
  const ENGINES = ['patch' + 'right', 'play' + 'wright'];
  const files = collectTsFiles(srcDir);

  for (const file of files) {
    const rel = file.replace(/\\/g, '/');
    const isSeam = rel.endsWith(SEAM_SUFFIX);
    test(`${rel} ${isSeam ? '(seam) static-imports no engine' : 'names no browser engine'}`, () => {
      const src = readFileSync(file, 'utf8');
      for (const engine of ENGINES) {
        // No production file may STATICALLY import a browser engine.
        expect(src).not.toContain(`from '${engine}'`);
        expect(src).not.toContain(`from "${engine}"`);
        // Only the seam may even name the engine (it loads it via dynamic import).
        if (!isSeam) {
          expect(src).not.toContain(`'${engine}'`);
          expect(src).not.toContain(`"${engine}"`);
        }
      }
    });
  }

  test('the seam loads its engine via dynamic import(), not a static import', () => {
    const seamPath = join(srcDir, 'runner', 'browser.ts');
    const src = readFileSync(seamPath, 'utf8');
    expect(src).toContain('import(ENGINE_MODULE)'); // dynamic, lazy
  });
});
