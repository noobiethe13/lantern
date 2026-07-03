/**
 * Deterministic posting-legitimacy ("ghost job") scorer. Pure — no DB, no LLM,
 * no clock access (caller passes `now`) — so it is fixture-testable.
 *
 * Output is framed as a signal, not an accusation: 'high' means "no red flags
 * found", never "verified real". Unknown inputs (null posted_at, unchecked
 * liveness) contribute nothing in either direction.
 */

export type Legitimacy = 'high' | 'caution' | 'suspicious';

export interface LegitimacySignals {
  now: number;
  postedAt: number | null;
  firstSeen: number;
  lastSeen: number;
  jdText: string | null;
  salaryDisclosed: boolean;
  liveness: 'active' | 'expired' | 'uncertain' | 'unchecked';
  url: string;
  /** Merged duplicate URLs on the canonical row (fuzzy dedup writes these). */
  duplicateUrls: string[];
}

/** A single signal: 'flag' counted against the posting, 'positive' for it. */
export interface LegitimacyReason {
  note: string;
  kind: 'flag' | 'positive';
}

export interface LegitimacyResult {
  legitimacy: Legitimacy;
  reasons: LegitimacyReason[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const STALE_POSTING_DAYS = 45;
const VERY_STALE_POSTING_DAYS = 90;
const LONG_OBSERVED_OPEN_DAYS = 45;
const THIN_JD_CHARS = 400;
const CROSS_BOARD_SPAM_HOSTS = 4;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function scoreLegitimacy(s: LegitimacySignals): LegitimacyResult {
  let score = 0;
  const reasons: LegitimacyReason[] = [];
  const flag = (weight: number, note: string) => {
    score += weight;
    reasons.push({ note, kind: weight < 0 ? 'positive' : 'flag' });
  };

  if (s.postedAt !== null) {
    const ageDays = Math.floor((s.now - s.postedAt) / DAY_MS);
    if (ageDays >= VERY_STALE_POSTING_DAYS) {
      flag(2, `posted ${ageDays} days ago and still listed`);
    } else if (ageDays >= STALE_POSTING_DAYS) {
      flag(1, `posted ${ageDays} days ago`);
    }
  }

  // Observed-open window: how long lantern itself has watched this posting stay
  // up across scans. Independent of posted_at (which boards can omit or fake).
  const observedDays = Math.floor((s.lastSeen - s.firstSeen) / DAY_MS);
  if (observedDays >= LONG_OBSERVED_OPEN_DAYS) {
    flag(1, `seen open across scans for ${observedDays} days`);
  }

  // null jd_text means the adapter doesn't fetch descriptions (SmartRecruiters/
  // Workable) — that's lantern's gap, not the posting's, so it contributes
  // nothing. Only a present-but-thin description is a vagueness signal.
  if (s.jdText !== null) {
    const jd = s.jdText.trim();
    if (jd.length < THIN_JD_CHARS) {
      flag(1, jd.length === 0 ? 'no job description provided' : 'very thin job description');
    }
  }

  if (s.liveness === 'expired') {
    flag(3, 'apply page appears closed');
  } else if (s.liveness === 'active') {
    flag(-1, 'apply page verified reachable');
  }

  // Fuzzy dedup merges a repost (same company+role, new URL) into this row's
  // duplicate_urls, so same-host entries mean the posting was re-listed on the
  // same board — repost churn. Many distinct hosts means it was blasted across
  // boards, a weaker spam signal (2–3 boards is normal syndication).
  const canonicalHost = hostOf(s.url);
  const dupHosts = s.duplicateUrls.map(hostOf).filter((h): h is string => h !== null);
  const sameHostReposts = canonicalHost
    ? dupHosts.filter(h => h === canonicalHost).length
    : 0;
  if (sameHostReposts >= 1) {
    flag(2, `re-listed ${sameHostReposts + 1} times on the same board`);
  }
  const distinctHosts = new Set([...(canonicalHost ? [canonicalHost] : []), ...dupHosts]).size;
  if (distinctHosts >= CROSS_BOARD_SPAM_HOSTS) {
    flag(1, `listed across ${distinctHosts} different boards`);
  }

  // Salary transparency is the strongest anti-ghost predictor — disclosed
  // comp offsets one weak flag. Absence is too common to count against.
  if (s.salaryDisclosed) {
    flag(-1, 'salary disclosed');
  }

  const legitimacy: Legitimacy = score <= 0 ? 'high' : score <= 2 ? 'caution' : 'suspicious';
  return { legitimacy, reasons };
}
