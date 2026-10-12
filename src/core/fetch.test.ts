import { afterEach, describe, expect, test } from 'bun:test';
import { assertSafeHttpUrl, assertValidSlug, fetchJson, fetchText, HttpStatusError } from './fetch';

describe('assertSafeHttpUrl — private/loopback host blocking', () => {
  test('rejects localhost', () => {
    expect(() => assertSafeHttpUrl('http://localhost/api')).toThrow(/private\/loopback/);
  });

  test('rejects 127.0.0.1', () => {
    expect(() => assertSafeHttpUrl('http://127.0.0.1:6379/')).toThrow(/private\/loopback/);
  });

  test('rejects 10.0.0.x', () => {
    expect(() => assertSafeHttpUrl('https://10.0.0.5/')).toThrow(/private\/loopback/);
  });

  test('rejects 192.168.x.x', () => {
    expect(() => assertSafeHttpUrl('https://192.168.1.1/')).toThrow(/private\/loopback/);
  });

  test('rejects 172.16/12 range', () => {
    expect(() => assertSafeHttpUrl('https://172.16.0.1/')).toThrow(/private\/loopback/);
    expect(() => assertSafeHttpUrl('https://172.31.255.255/')).toThrow(/private\/loopback/);
  });

  test('allows 172.15/172.32 (outside private range)', () => {
    expect(() => assertSafeHttpUrl('https://172.15.0.1/')).not.toThrow();
    expect(() => assertSafeHttpUrl('https://172.32.0.1/')).not.toThrow();
  });

  test('rejects 169.254.x.x (link-local)', () => {
    expect(() => assertSafeHttpUrl('http://169.254.169.254/')).toThrow(/private\/loopback/);
  });

  test('rejects ::1 IPv6 loopback', () => {
    expect(() => assertSafeHttpUrl('http://[::1]/')).toThrow(/private\/loopback/);
  });

  test('rejects fe80:: link-local IPv6', () => {
    expect(() => assertSafeHttpUrl('http://[fe80::1]/')).toThrow(/private\/loopback/);
  });

  test('rejects fc00:: / fd00:: unique-local IPv6', () => {
    expect(() => assertSafeHttpUrl('http://[fc00::1]/')).toThrow(/private\/loopback/);
    expect(() => assertSafeHttpUrl('http://[fd12::1]/')).toThrow(/private\/loopback/);
  });

  test('rejects a trailing-dot hostname that would otherwise dodge the ^localhost$ anchor', () => {
    expect(() => assertSafeHttpUrl('http://localhost.:6379/')).toThrow(/private\/loopback/);
  });

  test('rejects 0.0.0.0 ("this network" / unspecified)', () => {
    expect(() => assertSafeHttpUrl('http://0.0.0.0:8080/')).toThrow(/private\/loopback/);
  });

  test('rejects 100.64.0.0/10 (CGNAT / shared address space) but allows its edges', () => {
    expect(() => assertSafeHttpUrl('http://100.64.0.1/')).toThrow(/private\/loopback/);
    expect(() => assertSafeHttpUrl('http://100.127.255.255/')).toThrow(/private\/loopback/);
    expect(() => assertSafeHttpUrl('http://100.63.255.255/')).not.toThrow();
    expect(() => assertSafeHttpUrl('http://100.128.0.0/')).not.toThrow();
  });

  test('rejects :: (IPv6 unspecified address)', () => {
    expect(() => assertSafeHttpUrl('http://[::]/')).toThrow(/private\/loopback/);
  });

  test('rejects IPv4-mapped IPv6 addresses embedding a private IPv4', () => {
    expect(() => assertSafeHttpUrl('http://[::ffff:127.0.0.1]/')).toThrow(/private\/loopback/);
    expect(() => assertSafeHttpUrl('http://[::ffff:169.254.169.254]/')).toThrow(/private\/loopback/);
    // URL normalizes the dotted-quad form to hex groups — same address, same result.
    expect(() => assertSafeHttpUrl('http://[::ffff:7f00:1]/')).toThrow(/private\/loopback/);
  });

  test('rejects NAT64-embedded private IPv4 (64:ff9b::/96, RFC 6052)', () => {
    expect(() => assertSafeHttpUrl('http://[64:ff9b::7f00:1]/')).toThrow(/private\/loopback/); // 127.0.0.1
    expect(() => assertSafeHttpUrl('http://[64:ff9b::a9fe:a9fe]/')).toThrow(/private\/loopback/); // 169.254.169.254
  });

  test('allows IPv4-mapped/NAT64-shaped addresses that embed a public IPv4', () => {
    expect(() => assertSafeHttpUrl('http://[::ffff:8.8.8.8]/')).not.toThrow();
    expect(() => assertSafeHttpUrl('http://[64:ff9b::8.8.8.8]/')).not.toThrow();
  });

  test('allows a public IPv6 address', () => {
    expect(() => assertSafeHttpUrl('http://[2001:4860:4860::8888]/')).not.toThrow();
  });

  test('allows public hostnames', () => {
    expect(() => assertSafeHttpUrl('https://boards-api.greenhouse.io/v1/boards/foo/jobs')).not.toThrow();
    expect(() => assertSafeHttpUrl('https://api.ashbyhq.com/posting-api/job-board/foo')).not.toThrow();
  });
});

describe('assertSafeHttpUrl — scheme blocking', () => {
  test('rejects file://', () => {
    expect(() => assertSafeHttpUrl('file:///etc/passwd')).toThrow(/unsupported scheme/);
  });

  test('rejects ftp://', () => {
    expect(() => assertSafeHttpUrl('ftp://example.com/foo')).toThrow(/unsupported scheme/);
  });

  test('rejects javascript:', () => {
    expect(() => assertSafeHttpUrl('javascript:alert(1)')).toThrow(/unsupported scheme/);
  });

  test('rejects malformed URLs', () => {
    expect(() => assertSafeHttpUrl('not a url')).toThrow(/invalid URL/);
  });
});

describe('assertSafeHttpUrl — host allowlist', () => {
  test('accepts hosts in allowlist', () => {
    expect(() =>
      assertSafeHttpUrl('https://api.lever.co/v0/postings/foo', {
        allowedHosts: ['api.lever.co'],
      }),
    ).not.toThrow();
  });

  test('rejects public hosts outside allowlist', () => {
    expect(() =>
      assertSafeHttpUrl('https://evil.example.com/data', {
        allowedHosts: ['api.lever.co'],
      }),
    ).toThrow(/not in allowlist/);
  });

  test('private-host block precedes allowlist (defense in depth)', () => {
    expect(() =>
      assertSafeHttpUrl('http://127.0.0.1:6379/', {
        allowedHosts: ['127.0.0.1'],
      }),
    ).toThrow(/private\/loopback/);
  });
});

describe('assertValidSlug', () => {
  test('accepts plain alphanumerics + dashes', () => {
    expect(assertValidSlug('stripe')).toBe('stripe');
    expect(assertValidSlug('a1b2-c3')).toBe('a1b2-c3');
    expect(assertValidSlug('A')).toBe('A');
  });

  test('accepts dots in slugs (Ashby tenant convention)', () => {
    expect(assertValidSlug('lakera.ai')).toBe('lakera.ai');
    expect(assertValidSlug('foo.bar.baz')).toBe('foo.bar.baz');
  });

  test('rejects ".." traversal even when dots are allowed', () => {
    expect(() => assertValidSlug('..')).toThrow(/not a valid slug/);
    expect(() => assertValidSlug('foo..bar')).toThrow(/not a valid slug/);
  });

  test('rejects path traversal', () => {
    expect(() => assertValidSlug('../admin')).toThrow(/not a valid slug/);
    expect(() => assertValidSlug('foo/bar')).toThrow();
  });

  test('rejects URL-encoded segments', () => {
    expect(() => assertValidSlug('..%2Fadmin')).toThrow();
  });

  test('rejects leading dash', () => {
    expect(() => assertValidSlug('-stripe')).toThrow();
  });

  test('rejects leading dot', () => {
    expect(() => assertValidSlug('.stripe')).toThrow();
  });

  test('rejects empty / whitespace', () => {
    expect(() => assertValidSlug('')).toThrow();
    expect(() => assertValidSlug(' stripe')).toThrow();
  });

  test('rejects slugs longer than 64 chars', () => {
    expect(() => assertValidSlug('a'.repeat(65))).toThrow();
  });

  test('accepts slugs at the 64-char boundary', () => {
    expect(() => assertValidSlug('a'.repeat(64))).not.toThrow();
  });
});

describe('fetchJson / fetchText — retries and error snippets', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // SSRF guard runs before fetch, so stubs must sit behind a public-looking URL.
  const URL_ = 'https://api.example.com/jobs';
  // Keeps backoff sub-millisecond so retry tests don't slow the suite.
  const FAST = { retryBaseDelayMs: 0 };

  function stubFetch(impl: (calls: number) => Response | Error): { calls: () => number } {
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      const out = impl(n);
      if (out instanceof Error) throw out;
      return out;
    }) as unknown as typeof fetch;
    return { calls: () => n };
  }

  test('returns parsed JSON on success', async () => {
    stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    expect(await fetchJson(URL_)).toEqual({ ok: true });
  });

  test('POST with an object body JSON-encodes it and sets content-type', async () => {
    let captured: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response('{"total":1}', { status: 200 });
    }) as unknown as typeof fetch;

    await fetchJson(URL_, { method: 'POST', body: { offset: 0, limit: 20 } });
    expect(captured?.method).toBe('POST');
    expect(captured?.body).toBe('{"offset":0,"limit":20}');
    const headers = captured?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(captured?.redirect).toBe('error'); // SSRF contract preserved on POST
  });

  test('non-OK error includes status and a body snippet', async () => {
    stubFetch(() => new Response('<html>Service under maintenance, try later</html>', { status: 503 }));
    await expect(fetchJson(URL_)).rejects.toThrow(/HTTP 503 — .*Service under maintenance/);
  });

  test('body snippet is capped at 300 chars and whitespace-collapsed', async () => {
    stubFetch(() => new Response('a  b\n\nc' + 'x'.repeat(1000), { status: 500 }));
    try {
      await fetchJson(URL_);
      throw new Error('expected rejection');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toStartWith('HTTP 500 — a b c');
      expect(msg.length).toBeLessThanOrEqual('HTTP 500 — '.length + 300);
    }
  });

  test('no retries by default', async () => {
    const stub = stubFetch(() => new Response('boom', { status: 500 }));
    await expect(fetchJson(URL_)).rejects.toThrow(/HTTP 500/);
    expect(stub.calls()).toBe(1);
  });

  test('retries 5xx then succeeds', async () => {
    const stub = stubFetch(n =>
      n < 3 ? new Response('flaky', { status: 502 }) : new Response('{"ok":1}', { status: 200 }),
    );
    expect(await fetchJson(URL_, { retries: 2, ...FAST })).toEqual({ ok: 1 });
    expect(stub.calls()).toBe(3);
  });

  test('retries 429 (Retry-After honored as a delay, not a blocker)', async () => {
    const stub = stubFetch(n =>
      n === 1
        ? new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } })
        : new Response('done', { status: 200 }),
    );
    expect(await fetchText(URL_, { retries: 1, ...FAST })).toBe('done');
    expect(stub.calls()).toBe(2);
  });

  test('retries network-level failures', async () => {
    const stub = stubFetch(n =>
      n === 1 ? new Error('connection reset') : new Response('ok', { status: 200 }),
    );
    expect(await fetchText(URL_, { retries: 1, ...FAST })).toBe('ok');
    expect(stub.calls()).toBe(2);
  });

  test('does NOT retry permanent 4xx', async () => {
    const stub = stubFetch(() => new Response('nope', { status: 404 }));
    await expect(fetchJson(URL_, { retries: 3, ...FAST })).rejects.toThrow(/HTTP 404/);
    expect(stub.calls()).toBe(1);
  });

  test('exhausts retries and surfaces the last error with status', async () => {
    const stub = stubFetch(() => new Response('still down', { status: 503 }));
    try {
      await fetchJson(URL_, { retries: 2, ...FAST });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpStatusError);
      expect((err as HttpStatusError).status).toBe(503);
    }
    expect(stub.calls()).toBe(3);
  });

  test('SSRF guard rejection is never retried', async () => {
    const stub = stubFetch(() => new Response('ok', { status: 200 }));
    await expect(fetchJson('http://127.0.0.1/x', { retries: 3, ...FAST })).rejects.toThrow(/private\/loopback/);
    expect(stub.calls()).toBe(0);
  });
});

describe('fetchJson / fetchText — body timeout, retry, and size cap', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const URL_ = 'https://api.example.com/jobs';

  test('a body that stalls after headers arrive is aborted, not hung forever', async () => {
    // The stream never enqueues or closes on its own — simulates a server
    // that sends headers then stalls the body. A real fetch() ties its
    // AbortSignal to the in-flight response body, erroring a pending read on
    // abort; wire that explicitly here since a hand-built Response/stream
    // pair isn't produced by a real fetch. Before the fix, clearTimeout ran
    // as soon as headers arrived (before this body read), so the signal
    // firing had nothing left to abort and this awaited forever.
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
      },
    });
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => {
        controllerRef?.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const start = Date.now();
    await expect(fetchJson(URL_, { timeoutMs: 30 })).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test('a body-read failure mid-stream is retried like any other transient failure', async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      if (n === 1) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"partial'));
            controller.error(new Error('connection reset mid-body'));
          },
        });
        return new Response(stream, { status: 200 });
      }
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    expect(await fetchJson(URL_, { retries: 1, retryBaseDelayMs: 0 })).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  test('a JSON parse failure from a body that read to completion is not retried (M-3)', async () => {
    // Unlike the mid-stream case above (a genuine reader.read() error), this
    // body closes normally with no stream-level error at all — JSON.parse only
    // ever runs after the read finished successfully. That means the server
    // deterministically returns this same malformed body every time, so
    // retrying wastes an attempt instead of helping.
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      return new Response('{"incomplete', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(fetchJson(URL_, { retries: 2, retryBaseDelayMs: 0 })).rejects.toThrow(SyntaxError);
    expect(n).toBe(1);
  });

  test('a redirect:\'error\' rejection is not retried (M-3)', async () => {
    // Bun surfaces a refused redirect (redirect:'error', set by buildRequestInit
    // for the SSRF contract) as a plain Error whose message starts with
    // "UnexpectedRedirect". The same URL redirects the same way every time, so
    // retrying is pointless.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error('UnexpectedRedirect fetching "https://api.example.com/jobs".');
    }) as unknown as typeof fetch;

    await expect(fetchJson(URL_, { retries: 2, retryBaseDelayMs: 0 })).rejects.toThrow(/UnexpectedRedirect/);
    expect(calls).toBe(1);
  });

  test('rejects a response body over the size cap, and does not retry it', async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024); // 8 MB per chunk
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.enqueue(chunk); // 24 MB total — over the 20 MB cap
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(fetchJson(URL_, { retries: 2, retryBaseDelayMs: 0 })).rejects.toThrow(/exceeded.*byte cap/);
    expect(calls).toBe(1); // a huge body is deterministic, not transient — not worth retrying
  });
});
