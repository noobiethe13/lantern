import { describe, test, expect } from 'bun:test';
// ../test-harness already mocks db/client (and llm/index) process-wide and
// loads server.ts, which pulls in this file's module under test — ./liveness —
// for real via routes/jobs.ts. Importing the harness first means ./scan and
// ./browser (neither of which fetchLiveness/inputFromHtml actually touch) load
// against that same mock instead of a real db, so no separate stub is needed.
import '../test-harness';
import { fetchLiveness, inputFromHtml, MAX_REDIRECTS, MAX_BODY_BYTES } from './liveness';

function textResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('fetchLiveness SSRF guard', () => {
  test('refuses a private/loopback initial URL without ever calling fetch', async () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => { called = true; return textResponse(200, 'x'); }) as unknown as typeof fetch;
    try {
      const result = await fetchLiveness('http://127.0.0.1:8080/admin');
      expect(result).toBeNull();
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('refuses to follow a redirect to a private host', async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return textResponse(302, '', { location: 'http://169.254.169.254/latest/meta-data/' });
    }) as unknown as typeof fetch;
    try {
      const result = await fetchLiveness('https://boards.example.com/jobs/1');
      expect(result).toBeNull();
      expect(calls).toBe(1); // never fetched the redirect target
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('follows a relative Location on a safe host and resolves it against the current URL', async () => {
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(url);
      if (seen.length === 1) return textResponse(301, '', { location: '/jobs/1-moved' });
      return textResponse(200, `<html><body>${'x'.repeat(400)}<a>Apply now</a></body></html>`);
    }) as unknown as typeof fetch;
    try {
      const result = await fetchLiveness('https://boards.example.com/jobs/1');
      expect(seen).toEqual(['https://boards.example.com/jobs/1', 'https://boards.example.com/jobs/1-moved']);
      expect(result?.finalUrl).toBe('https://boards.example.com/jobs/1-moved');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('gives up past MAX_REDIRECTS hops instead of following forever', async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return textResponse(302, '', { location: `https://boards.example.com/hop-${calls}` });
    }) as unknown as typeof fetch;
    try {
      const result = await fetchLiveness('https://boards.example.com/start');
      expect(result).toBeNull();
      expect(calls).toBeLessThanOrEqual(MAX_REDIRECTS + 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('fetchLiveness body cap', () => {
  test('abandons the stream past MAX_BODY_BYTES instead of buffering an unbounded body', async () => {
    const realFetch = globalThis.fetch;
    const CHUNK = 512 * 1024;
    const chunkText = 'x'.repeat(CHUNK);
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode(chunkText));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await fetchLiveness('https://boards.example.com/jobs/huge');
      expect(result).not.toBeNull();
      // Capped at ~MAX_BODY_BYTES (allowing one chunk of overshoot), never the
      // unbounded stream this fake server would otherwise supply forever.
      expect(result!.bodyText.length).toBeLessThan(MAX_BODY_BYTES + CHUNK);
      expect(result!.bodyText.length).toBeGreaterThanOrEqual(MAX_BODY_BYTES);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('inputFromHtml', () => {
  test('strips script/style/noscript/template so inline JSON-LD/i18n strings do not leak into bodyText', () => {
    const html = `
      <html><body>
        <script>var x = "This job is no longer available";</script>
        <style>.hidden { display: none; }</style>
        <noscript>Applications closed for the 2024 cohort</noscript>
        <template><p>This job has expired</p></template>
        <main>${'Real job content. '.repeat(30)}</main>
        <a>Apply now</a>
      </body></html>`;
    const input = inputFromHtml(200, 'https://boards.example.com/jobs/1', html);
    expect(input.bodyText).not.toContain('no longer available');
    expect(input.bodyText).not.toContain('Applications closed');
    expect(input.bodyText).not.toContain('has expired');
    expect(input.bodyText).toContain('Real job content.');
  });

  test('still strips nav/header/footer chrome (pre-existing behavior preserved)', () => {
    const html = `<html><body><nav><a>Apply now</a></nav><main>${'Real content. '.repeat(30)}</main></body></html>`;
    const input = inputFromHtml(200, 'https://boards.example.com/jobs/1', html);
    expect(input.applyControls).toEqual([]);
  });
});
