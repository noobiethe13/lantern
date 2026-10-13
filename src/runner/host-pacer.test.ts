import { describe, expect, test } from 'bun:test';
import { HttpStatusError } from '../core/fetch';
import { HOST_BACKOFF_BASE_MS, HOST_BACKOFF_MAX_MS, HostPacer, hostKey, isRateLimited, runHostPool } from './host-pacer';

function pacer(limit = { maxInFlight: 2, paceMs: 1_000 }, random = () => 0.5) {
  const clock = { t: 0 };
  return { clock, p: new HostPacer({ limit: () => limit, now: () => clock.t, random }) };
}

describe('HostPacer', () => {
  test('caps in-flight starts per host and frees a slot on end', () => {
    const { p } = pacer({ maxInFlight: 2, paceMs: 0 });
    p.begin('workable');
    p.begin('workable');
    expect(p.canStart('workable')).toBe(false);
    expect(p.canStart('lever')).toBe(true);
    p.end('workable');
    expect(p.canStart('workable')).toBe(true);
  });

  test('jitters the gap between starts to 75-125% of paceMs', () => {
    const low = pacer({ maxInFlight: 9, paceMs: 1_000 }, () => 0);
    low.p.begin('h');
    expect(low.p.startableAt('h')).toBe(750);
    const high = pacer({ maxInFlight: 9, paceMs: 1_000 }, () => 0.999999);
    high.p.begin('h');
    expect(high.p.startableAt('h')).toBeCloseTo(1_250, 0);
    low.clock.t = 749;
    expect(low.p.canStart('h')).toBe(false);
    low.clock.t = 750;
    expect(low.p.canStart('h')).toBe(true);
  });

  test('a 429 rests the host, doubling per strike, capped, with one strike per burst', () => {
    const { clock, p } = pacer({ maxInFlight: 9, paceMs: 0 });
    // random 0.5 means a rest jitter factor of exactly 1.
    expect(p.rateLimited('w')).toBe(HOST_BACKOFF_BASE_MS);
    expect(p.isResting('w')).toBe(true);
    expect(p.canStart('w')).toBe(false);
    // A second in-flight fetch reporting the same 429 neither extends nor strikes again.
    expect(p.rateLimited('w')).toBe(HOST_BACKOFF_BASE_MS);
    clock.t = HOST_BACKOFF_BASE_MS;
    expect(p.isResting('w')).toBe(false);
    expect(p.rateLimited('w')).toBe(clock.t + HOST_BACKOFF_BASE_MS * 2);
    for (let i = 0; i < 12; i++) {
      clock.t = p.restingUntil('w');
      p.rateLimited('w');
    }
    expect(p.restingUntil('w') - clock.t).toBe(HOST_BACKOFF_MAX_MS);
  });

  test('a success clears the strikes only once the rest is over', () => {
    const { clock, p } = pacer({ maxInFlight: 9, paceMs: 0 });
    p.rateLimited('w');
    p.succeeded('w');
    expect(p.isResting('w')).toBe(true);
    clock.t = HOST_BACKOFF_BASE_MS;
    p.succeeded('w');
    expect(p.rateLimited('w')).toBe(clock.t + HOST_BACKOFF_BASE_MS);
  });
});

describe('hostKey', () => {
  const src = (type: string, identifier = 'acme', config_json: string | null = null) => ({ type, identifier, config_json });

  test('per-tenant subdomains share their vendor key', () => {
    expect(hostKey(src('recruitee', 'a'))).toBe(hostKey(src('recruitee', 'b')));
    expect(hostKey(src('personio', 'a'))).toBe('personio');
  });

  test('workday tenants are separate hosts', () => {
    expect(hostKey(src('workday', 'nvidia', '{"dc":"wd5","site":"x"}'))).toBe('workday:nvidia.wd5');
    expect(hostKey(src('workday', 'a', '{"host":"a.wd1.myworkdayjobs.com"}'))).toBe('workday:a.wd1.myworkdayjobs.com');
    expect(hostKey(src('workday', 'a', '{bad'))).toBe('workday');
  });
});

test('isRateLimited recognises a 429 status error and a wrapped message', () => {
  expect(isRateLimited(new HttpStatusError(429, null, 'HTTP 429'))).toBe(true);
  expect(isRateLimited(new Error('x: HTTP 429 Too Many'))).toBe(true);
  expect(isRateLimited(new HttpStatusError(404, null, 'HTTP 404'))).toBe(false);
});

describe('runHostPool', () => {
  const noopSkip = () => {};

  test('never exceeds the per-host cap yet keeps other hosts busy', async () => {
    const p = new HostPacer({ limit: key => ({ maxInFlight: key === 'a' ? 2 : 9, paceMs: 0 }) });
    const active: Record<string, number> = { a: 0, b: 0 };
    const peak: Record<string, number> = { a: 0, b: 0 };
    // All of host a first: a plain FIFO pool would park every slot on it.
    const items = [
      ...Array.from({ length: 8 }, (_, i) => ({ host: 'a', i })),
      ...Array.from({ length: 4 }, (_, i) => ({ host: 'b', i })),
    ];
    await runHostPool(items, 6, { pacer: p, keyOf: t => t.host, onSkip: noopSkip }, async t => {
      active[t.host]!++;
      peak[t.host] = Math.max(peak[t.host]!, active[t.host]!);
      await new Promise(r => setTimeout(r, 10));
      active[t.host]!--;
    }, () => {});
    expect(peak['a']).toBe(2);
    expect(peak['b']).toBeGreaterThan(1);
  });

  test('skips the rest of a host resting too long to wait for, and runs the others', async () => {
    const p = new HostPacer({ limit: () => ({ maxInFlight: 1, paceMs: 0 }), backoffBaseMs: 10 * 60_000 });
    const ran: string[] = [];
    const skipped: string[] = [];
    await runHostPool(['w1', 'w2', 'w3', 'g1'], 3, {
      pacer: p,
      keyOf: t => (t[0] === 'w' ? 'workable' : 'greenhouse'),
      onSkip: t => skipped.push(t),
    }, async t => {
      ran.push(t);
      if (t === 'w1') p.rateLimited('workable');
      await new Promise(r => setTimeout(r, 5));
    }, () => {});
    expect(ran.sort()).toEqual(['g1', 'w1']);
    expect(skipped.sort()).toEqual(['w2', 'w3']);
  });

  test('spaces starts on one host by the pace gap', async () => {
    const p = new HostPacer({ limit: () => ({ maxInFlight: 9, paceMs: 40 }) });
    const starts: number[] = [];
    await runHostPool([1, 2, 3], 3, { pacer: p, keyOf: () => 'h', onSkip: noopSkip }, async () => {
      starts.push(Date.now());
    }, () => {});
    expect(starts.length).toBe(3);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(25);
  });

  test('a throwing worker goes to onError and the pool continues', async () => {
    const p = new HostPacer({ limit: () => ({ maxInFlight: 1, paceMs: 0 }) });
    const errored: number[] = [];
    const done: number[] = [];
    await runHostPool([1, 2, 3], 2, { pacer: p, keyOf: () => 'h', onSkip: noopSkip }, async n => {
      if (n === 2) throw new Error('boom');
      done.push(n);
    }, n => errored.push(n));
    expect(done).toEqual([1, 3]);
    expect(errored).toEqual([2]);
  });
});
