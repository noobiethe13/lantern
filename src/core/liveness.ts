const HARD_EXPIRED = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
  /closed on \d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /closed on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expirée|n'est plus disponible)/i,
];
const LISTING_PAGE = [
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];
const EXPIRED_URL = [/[?&]error=true/i];
const APPLY_RX = [
  /\bapply\b/i, /\bsolicitar\b/i, /\bbewerben\b/i, /\bpostuler\b/i,
  /submit application/i, /easy apply/i, /start application/i, /ich bewerbe mich/i,
];
const MIN_CONTENT = 300;

// Hosts that render job pages client-side: a plain fetch returns a near-empty
// JS shell, so thin content there proves nothing about the posting's state.
// Grow this list as more SPA boards are observed.
const SPA_HOSTS = ['ashbyhq.com', 'apply.workable.com'];

function isSpaHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SPA_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

export interface LivenessInput {
  status: number;
  finalUrl: string;
  bodyText: string;
  applyControls: string[];
}

export type LivenessResult = { result: 'expired' | 'active' | 'uncertain'; reason: string };

export function classifyLiveness(i: LivenessInput): LivenessResult {
  if (i.status === 404 || i.status === 410)
    return { result: 'expired', reason: `HTTP ${i.status}` };

  if (EXPIRED_URL.some(p => p.test(i.finalUrl)))
    return { result: 'expired', reason: `redirect to ${i.finalUrl}` };

  const expBody = HARD_EXPIRED.find(p => p.test(i.bodyText));
  if (expBody) return { result: 'expired', reason: `pattern ${expBody.source}` };

  if (i.applyControls.some(c => APPLY_RX.some(p => p.test(c))))
    return { result: 'active', reason: 'visible apply control' };

  const list = LISTING_PAGE.find(p => p.test(i.bodyText));
  if (list) return { result: 'expired', reason: `listing redirect ${list.source}` };

  if (i.bodyText.trim().length < MIN_CONTENT) {
    if (isSpaHost(i.finalUrl))
      return { result: 'uncertain', reason: 'thin content on client-rendered host' };
    return { result: 'expired', reason: 'insufficient content' };
  }

  return { result: 'uncertain', reason: 'no apply control found' };
}

export { MIN_CONTENT, isSpaHost };
