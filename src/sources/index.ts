import type { SourceAdapter } from '../core/job';
import { GreenhouseAdapter } from './greenhouse';
import { AshbyAdapter } from './ashby';
import { LeverAdapter } from './lever';
import { RecruiteeAdapter } from './recruitee';
import { SmartRecruitersAdapter } from './smartrecruiters';
import { WorkableAdapter } from './workable';
import { PersonioAdapter } from './personio';
import { BambooHrAdapter } from './bamboohr';
import { WorkdayAdapter } from './workday';
import { RemoteOkAdapter } from './remoteok';
import { ArbeitnowAdapter } from './arbeitnow';
import { HimalayasAdapter } from './himalayas';
import { LinkedInAdapter } from './linkedin';
import { GoogleJobsAdapter } from './google-jobs';
import { JobicyAdapter } from './jobicy';
import { TheMuseAdapter } from './themuse';
import { SmartRecruitersSearchAdapter } from './smartrecruiters-search';
import { WorkingNomadsAdapter } from './workingnomads';
import { WeWorkRemotelyAdapter } from './weworkremotely';
import { RemotiveAdapter } from './remotive';
import { JobTechAdapter } from './jobtech';
import { HnHiringAdapter } from './hn-hiring';
import { BreezyAdapter } from './breezy';
import { RipplingAdapter } from './rippling';
import { TeamtailorAdapter } from './teamtailor';

export const adapterRegistry: Record<string, SourceAdapter> = {
  greenhouse: new GreenhouseAdapter(),
  ashby: new AshbyAdapter(),
  lever: new LeverAdapter(),
  recruitee: new RecruiteeAdapter(),
  smartrecruiters: new SmartRecruitersAdapter(),
  workable: new WorkableAdapter(),
  personio: new PersonioAdapter(),
  bamboohr: new BambooHrAdapter(),
  workday: new WorkdayAdapter(),
  remoteok: new RemoteOkAdapter(),
  arbeitnow: new ArbeitnowAdapter(),
  himalayas: new HimalayasAdapter(),
  linkedin: new LinkedInAdapter(),
  google_jobs: new GoogleJobsAdapter(),
  jobicy: new JobicyAdapter(),
  themuse: new TheMuseAdapter(),
  smartrecruiters_search: new SmartRecruitersSearchAdapter(),
  workingnomads: new WorkingNomadsAdapter(),
  weworkremotely: new WeWorkRemotelyAdapter(),
  remotive: new RemotiveAdapter(),
  jobtech: new JobTechAdapter(),
  hn_hiring: new HnHiringAdapter(),
  breezy: new BreezyAdapter(),
  rippling: new RipplingAdapter(),
  teamtailor: new TeamtailorAdapter(),
};

export function getAdapter(type: string): SourceAdapter | null {
  return adapterRegistry[type] ?? null;
}

export type DetectedBoard =
  | { type: 'greenhouse'; identifier: string }
  | { type: 'ashby'; identifier: string }
  | { type: 'lever'; identifier: string }
  | { type: 'recruitee'; identifier: string }
  | { type: 'smartrecruiters'; identifier: string }
  | { type: 'workable'; identifier: string }
  | { type: 'personio'; identifier: string }
  | { type: 'bamboohr'; identifier: string }
  | { type: 'breezy'; identifier: string }
  | { type: 'rippling'; identifier: string }
  | { type: 'teamtailor'; identifier: string };

// Teamtailor's own product/marketing subdomains, which are not customer tenants.
const TEAMTAILOR_RESERVED_HOSTS = new Set([
  'www', 'app', 'api', 'support', 'help', 'docs', 'status', 'blog', 'partner', 'partners',
  'admin', 'auth', 'login', 'cdn', 'assets', 'static', 'mail',
]);

/**
 * Best-effort detection of a board type + identifier from a public careers URL.
 * Per-company boards key off their tenant slug, which the adapters re-derive
 * into the canonical API/feed URL (so detection only needs the slug, not the
 * full API URL). Returns null when no known board pattern matches.
 */
export function detectBoard(careersUrl: string): DetectedBoard | null {
  const url = careersUrl ?? '';

  const ashby = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashby) return { type: 'ashby', identifier: ashby[1] };

  const lever = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (lever) return { type: 'lever', identifier: lever[1] };

  const ghEu = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEu) return { type: 'greenhouse', identifier: ghEu[1] };

  const recruitee = url.match(/^https?:\/\/([a-z0-9][a-z0-9-]*)\.recruitee\.com/i);
  if (recruitee) return { type: 'recruitee', identifier: recruitee[1] };

  const sr = url.match(/(?:careers|jobs)\.smartrecruiters\.com\/([^/?#]+)/);
  if (sr) return { type: 'smartrecruiters', identifier: sr[1] };

  const workable = url.match(/apply\.workable\.com\/([^/?#]+)/);
  if (workable) return { type: 'workable', identifier: workable[1] };

  const personio = url.match(/^https?:\/\/([a-z0-9][a-z0-9-]*)\.jobs\.personio\.(?:de|com)/i);
  if (personio) return { type: 'personio', identifier: personio[1] };

  const bamboohr = url.match(/^https?:\/\/([a-z0-9][a-z0-9-]*)\.bamboohr\.com/i);
  if (bamboohr) return { type: 'bamboohr', identifier: bamboohr[1] };

  const breezy = url.match(/^https?:\/\/([a-z0-9][a-z0-9-]*)\.breezy\.hr(?:[/?#:]|$)/i);
  if (breezy) return { type: 'breezy', identifier: breezy[1] };

  // An optional locale segment (`en-GB`) can precede the slug, but only when
  // another segment follows that isn't `jobs` (so a 2-letter slug still works).
  const rippling = url.match(
    /^https?:\/\/ats\.rippling\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/(?!jobs(?:[/?#]|$)))?([a-z0-9][a-z0-9.-]*)(?:[/?#:]|$)/i,
  );
  if (rippling) return { type: 'rippling', identifier: rippling[1] };

  // Only `{slug}.teamtailor.com` — tenants on custom domains can't be told apart
  // from arbitrary hosts, and the adapter pins its fetch to the teamtailor.com host.
  const teamtailor = url.match(/^https?:\/\/([a-z0-9][a-z0-9-]*)\.teamtailor\.com(?:[/?#:]|$)/i);
  if (teamtailor && !TEAMTAILOR_RESERVED_HOSTS.has(teamtailor[1].toLowerCase())) {
    return { type: 'teamtailor', identifier: teamtailor[1] };
  }

  // Workday is intentionally not auto-detected: its source needs a composite
  // tenant + datacenter + site (config_json), which DetectedBoard's single
  // `identifier` can't carry. Workday sources are added via Settings / seeds.

  return null;
}
