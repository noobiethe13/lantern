import { describe, expect, test } from 'bun:test';
import { isBrowserAvailable, isRequestAllowed, renderPage } from './browser';

// The browser engine is an OPTIONAL dependency not present in a default install
// (and absent in CI). These assert the graceful-absent contract and the
// engine-independent SSRF guard. The absent-path assertions skip if a developer
// has installed the engine locally, so they never produce a false failure.
describe('browser tier seam', () => {
  test('isBrowserAvailable resolves to a boolean', async () => {
    expect(typeof (await isBrowserAvailable())).toBe('boolean');
  });

  test('renderPage returns null (does not throw) when the engine is absent', async () => {
    if (await isBrowserAvailable()) return; // engine installed locally → absent-path N/A
    expect(await renderPage('https://example.com/jobs')).toBeNull();
  });

  test('renderPage enforces the SSRF guard before any navigation (engine-independent)', async () => {
    // Link-local metadata IP is rejected by assertSafeHttpUrl regardless of whether
    // the engine is installed — a browser navigation is an outbound request too.
    await expect(renderPage('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
    await expect(renderPage('http://127.0.0.1:3000/admin')).rejects.toThrow();
  });
});

describe('isRequestAllowed (navigation redirect/subresource SSRF filter)', () => {
  test('allows public http(s) hosts', () => {
    expect(isRequestAllowed('https://jobs.example.com/search?q=x')).toBe(true);
    expect(isRequestAllowed('http://example.com/path')).toBe(true);
  });

  test('blocks private / loopback / metadata hosts (redirect-target defense)', () => {
    expect(isRequestAllowed('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isRequestAllowed('http://127.0.0.1:3000/admin')).toBe(false);
  });

  test('passes non-network schemes (data:/blob:) — not SSRF vectors', () => {
    expect(isRequestAllowed('data:text/html,<p>x</p>')).toBe(true);
  });

  test('rejects unparseable URLs', () => {
    expect(isRequestAllowed('not a url')).toBe(false);
  });
});
