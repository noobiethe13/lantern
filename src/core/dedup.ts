import type { Job } from './job';
import { sha256hex } from './hash';

export function contentHash(job: Job): string {
  const parts = [
    job.title,
    job.location ?? '',
    job.jd_text ?? '',
  ];
  return sha256hex(parts.join('|'));
}
