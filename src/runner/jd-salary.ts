import type { Job } from '../core/job';
import { extractSalaryFromText } from '../core/salary';

/** Where a stored salary came from: the source's structured field, or description text. */
export type SalarySource = 'ats' | 'jd';

type SalaryFields = Pick<Job, 'salary_min_usd' | 'salary_max_usd' | 'salary_currency'>;

/** True when the job carries any salary field. Same triple the upsert path uses. */
export function hasSalary(job: SalaryFields): boolean {
  return job.salary_min_usd != null || job.salary_max_usd != null || job.salary_currency != null;
}

/**
 * Fill a salaryless job's salary from description text, so L1's floor can act on
 * it. Never overrides a salary the source supplied. `jdText` defaults to the
 * job's own and exists for re-sightings whose listing has no JD but whose stored
 * row does.
 */
export function fillSalaryFromJd(job: Job, jdText: string | undefined = job.jd_text): Job | null {
  if (hasSalary(job) || !jdText) return null;
  const found = extractSalaryFromText(jdText, { location: job.location });
  if (!found) return null;
  return {
    ...job,
    salary_min_usd: found.min,
    salary_max_usd: found.max,
    salary_currency: found.currency,
  };
}
