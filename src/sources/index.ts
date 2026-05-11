import type { SourceAdapter } from '../core/job';
import { GreenhouseAdapter } from './greenhouse';
import { AshbyAdapter } from './ashby';
import { LeverAdapter } from './lever';
import { HNWhosHiringAdapter } from './hn-whos-hiring';
import { GenericUrlAdapter } from './generic-url';
import { XGrokAdapter } from './x-grok';

export const adapterRegistry: Record<string, SourceAdapter> = {
  greenhouse: new GreenhouseAdapter(),
  ashby: new AshbyAdapter(),
  lever: new LeverAdapter(),
  'hn-whos-hiring': new HNWhosHiringAdapter(),
  'generic-url': new GenericUrlAdapter(),
  'x-grok': new XGrokAdapter(),
};

export function getAdapter(type: string): SourceAdapter | null {
  return adapterRegistry[type] ?? null;
}

export function detectBoard(
  careersUrl: string,
  explicitApi?: string
):
  | { type: 'greenhouse'; api: string }
  | { type: 'ashby'; api: string }
  | { type: 'lever'; api: string }
  | null {
  if (explicitApi?.includes('greenhouse')) {
    return { type: 'greenhouse', api: explicitApi };
  }
  const url = careersUrl ?? '';

  const ashby = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashby)
    return {
      type: 'ashby',
      api: `https://api.ashbyhq.com/posting-api/job-board/${ashby[1]}?includeCompensation=true`,
    };

  const lever = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (lever)
    return {
      type: 'lever',
      api: `https://api.lever.co/v0/postings/${lever[1]}`,
    };

  const ghEu = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEu)
    return {
      type: 'greenhouse',
      api: `https://boards-api.greenhouse.io/v1/boards/${ghEu[1]}/jobs`,
    };

  return null;
}
