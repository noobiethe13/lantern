import { describe, expect, test } from 'bun:test';
import { assertSafeHttpUrl, assertValidSlug } from './fetch';

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
