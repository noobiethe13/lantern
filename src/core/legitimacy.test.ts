import { describe, expect, test } from 'bun:test';
import { scoreLegitimacy, type LegitimacyResult, type LegitimacySignals } from './legitimacy';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_750_000_000_000;

const RICH_JD = 'We are hiring a senior backend engineer. '.repeat(20); // ~840 chars

function signals(overrides: Partial<LegitimacySignals> = {}): LegitimacySignals {
  return {
    now: NOW,
    postedAt: NOW - 5 * DAY_MS,
    firstSeen: NOW - 2 * DAY_MS,
    lastSeen: NOW,
    jdText: RICH_JD,
    salaryDisclosed: false,
    liveness: 'unchecked',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    duplicateUrls: [],
    ...overrides,
  };
}

const notes = (r: LegitimacyResult) => r.reasons.map(x => x.note);

describe('scoreLegitimacy', () => {
  test('fresh posting with a real JD and no flags scores high', () => {
    const r = scoreLegitimacy(signals());
    expect(r.legitimacy).toBe('high');
    expect(r.reasons).toEqual([]);
  });

  test('unknown inputs contribute nothing (null posted_at, unchecked liveness, null jd)', () => {
    const r = scoreLegitimacy(signals({ postedAt: null, jdText: null }));
    expect(r.legitimacy).toBe('high');
    expect(r.reasons).toEqual([]);
  });

  test('stale posting (45–89 days) is a single caution flag', () => {
    const r = scoreLegitimacy(signals({ postedAt: NOW - 50 * DAY_MS }));
    expect(r.legitimacy).toBe('caution');
    expect(r.reasons).toEqual([{ note: 'posted 50 days ago', kind: 'flag' }]);
  });

  test('very stale posting (90+ days) weighs double', () => {
    const r = scoreLegitimacy(signals({ postedAt: NOW - 120 * DAY_MS, jdText: 'short' }));
    expect(r.legitimacy).toBe('suspicious');
    expect(notes(r)).toContain('posted 120 days ago and still listed');
  });

  test('long observed-open window flags independently of posted_at', () => {
    const r = scoreLegitimacy(
      signals({ postedAt: null, firstSeen: NOW - 60 * DAY_MS, lastSeen: NOW })
    );
    expect(r.legitimacy).toBe('caution');
    expect(notes(r)).toEqual(['seen open across scans for 60 days']);
  });

  test('thin JD flags only when the adapter actually fetched a description', () => {
    expect(notes(scoreLegitimacy(signals({ jdText: 'short blurb' })))).toEqual([
      'very thin job description',
    ]);
    expect(notes(scoreLegitimacy(signals({ jdText: '  ' })))).toEqual([
      'no job description provided',
    ]);
    expect(notes(scoreLegitimacy(signals({ jdText: null })))).toEqual([]);
  });

  test('expired liveness alone is suspicious (listing up, apply closed)', () => {
    const r = scoreLegitimacy(signals({ liveness: 'expired' }));
    expect(r.legitimacy).toBe('suspicious');
    expect(r.reasons).toEqual([{ note: 'apply page appears closed', kind: 'flag' }]);
  });

  test('active liveness offsets one weak flag and is marked positive', () => {
    const r = scoreLegitimacy(
      signals({ liveness: 'active', postedAt: NOW - 50 * DAY_MS })
    );
    expect(r.legitimacy).toBe('high');
    expect(r.reasons).toContainEqual({ note: 'apply page verified reachable', kind: 'positive' });
    expect(r.reasons).toContainEqual({ note: 'posted 50 days ago', kind: 'flag' });
  });

  test('salary disclosure offsets one weak flag and is marked positive', () => {
    const r = scoreLegitimacy(
      signals({ salaryDisclosed: true, postedAt: NOW - 50 * DAY_MS })
    );
    expect(r.legitimacy).toBe('high');
    expect(r.reasons).toContainEqual({ note: 'salary disclosed', kind: 'positive' });
  });

  test('same-host duplicate URL means repost churn (strong flag)', () => {
    const r = scoreLegitimacy(
      signals({ duplicateUrls: ['https://boards.greenhouse.io/acme/jobs/9'] })
    );
    expect(r.legitimacy).toBe('caution');
    expect(notes(r)).toEqual(['re-listed 2 times on the same board']);
  });

  test('2–3 distinct boards is normal syndication, 4+ flags', () => {
    const twoBoards = scoreLegitimacy(
      signals({ duplicateUrls: ['https://remoteok.com/jobs/1'] })
    );
    expect(twoBoards.legitimacy).toBe('high');

    const fourBoards = scoreLegitimacy(
      signals({
        duplicateUrls: [
          'https://remoteok.com/jobs/1',
          'https://himalayas.app/jobs/1',
          'https://arbeitnow.com/jobs/1',
        ],
      })
    );
    expect(fourBoards.legitimacy).toBe('caution');
    expect(notes(fourBoards)).toEqual(['listed across 4 different boards']);
  });

  test('flags accumulate to suspicious', () => {
    const r = scoreLegitimacy(
      signals({
        postedAt: NOW - 120 * DAY_MS,
        firstSeen: NOW - 60 * DAY_MS,
        jdText: 'vague',
      })
    );
    expect(r.legitimacy).toBe('suspicious');
    expect(r.reasons).toHaveLength(3);
  });

  test('unparseable URLs are ignored rather than thrown on', () => {
    const r = scoreLegitimacy(
      signals({ url: 'not a url', duplicateUrls: ['also not a url'] })
    );
    expect(r.legitimacy).toBe('high');
  });
});
