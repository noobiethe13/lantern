import { describe, expect, test } from 'bun:test';
import { parseLinkedIn } from './linkedin';

// Trimmed real shape from the guest `seeMoreJobPostings/search` fragment: a
// `<ul>` of `<li>` cards. Card 1 is complete; card 2 uses the `--new` listdate
// variant and a remote/location signal; card 3 is missing a title (dropped).
const HTML = `
<li>
  <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:4426342261">
    <a class="base-card__full-link" href="https://pl.linkedin.com/jobs/view/backend-developer-at-acme-4426342261?position=1&refId=abc&trackingId=xyz">
      <span class="sr-only">Backend Developer</span>
    </a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title">Backend Developer (Python)</h3>
      <h4 class="base-search-card__subtitle">
        <a class="hidden-nested-link" href="https://de.linkedin.com/company/acme">Acme GmbH</a>
      </h4>
      <div class="base-search-card__metadata">
        <span class="job-search-card__location">Poland</span>
        <time class="job-search-card__listdate" datetime="2026-06-09">3 days ago</time>
      </div>
    </div>
  </div>
</li>
<li>
  <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:4426353014">
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/staff-sre-remote-at-globex-4426353014?trk=public_jobs">
      <span class="sr-only">Staff SRE</span>
    </a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title">Staff SRE — Remote</h3>
      <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="x">Globex</a></h4>
      <div class="base-search-card__metadata">
        <span class="job-search-card__location">European Union</span>
        <time class="job-search-card__listdate--new" datetime="2026-06-12">1 day ago</time>
      </div>
    </div>
  </div>
</li>
<li>
  <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:999">
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/x-999"></a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title"></h3>
      <h4 class="base-search-card__subtitle"><a href="y">Initech</a></h4>
    </div>
  </div>
</li>`;

describe('parseLinkedIn', () => {
  test('parses cards, strips tracking params, derives id from urn', () => {
    const jobs = parseLinkedIn(HTML);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      external_id: '4426342261',
      title: 'Backend Developer (Python)',
      url: 'https://pl.linkedin.com/jobs/view/backend-developer-at-acme-4426342261',
      company: 'Acme GmbH',
      location: 'Poland',
      remote: false,
    });
    expect(jobs[0].posted_at).toBe(Date.parse('2026-06-09'));
  });

  test('handles the --new listdate variant and flags remote from title', () => {
    const job = parseLinkedIn(HTML)[1];
    expect(job).toMatchObject({ external_id: '4426353014', remote: true });
    expect(job.posted_at).toBe(Date.parse('2026-06-12'));
  });

  test('omits jd_text entirely (null in DB, not a ghost flag)', () => {
    expect(parseLinkedIn(HTML)[0].jd_text).toBeUndefined();
  });

  test('drops cards missing a title', () => {
    expect(parseLinkedIn(HTML).some(j => j.external_id === '999')).toBe(false);
  });

  test('returns [] for empty input', () => {
    expect(parseLinkedIn('')).toEqual([]);
  });
});
