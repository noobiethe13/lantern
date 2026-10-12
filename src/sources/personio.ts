import { load as cheerioLoad } from 'cheerio';
import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchText } from '../core/fetch';
import { htmlToText } from './aggregator-util';

/**
 * Parse Personio's public recruiting XML feed. Each tenant exposes its open
 * roles at `https://<company>.jobs.personio.de/xml`; there is no JSON surface.
 * The feed is a `<workzag-jobs>` document of `<position>` elements (id, name,
 * office, department, employmentType, …). The public posting URL is not in the
 * feed, so we synthesise it from the tenant host + position id. Positions with
 * no id or name are dropped.
 */
export function parsePersonioXml(xml: string, company: string, host: string): Job[] {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  const $ = cheerioLoad(xml, { xmlMode: true });

  const jobs: Job[] = [];
  $('position').each((_i, el) => {
    const pos = $(el);
    const id = pos.find('id').first().text().trim();
    const title = pos.find('name').first().text().trim();
    if (!id || !title) return;

    // `department` is not a location and must not be joined in (it was
    // previously joined as "Munich · Product and Tech", which meant an
    // allow-list of just [berlin] rejected the job even though Berlin is one
    // of its additionalOffices). Every additionalOffices > office is a real
    // secondary work location and belongs alongside the primary office.
    const office = pos.find('office').first().text().trim();
    const additionalOffices: string[] = [];
    pos.find('additionalOffices').find('office').each((_j, o) => {
      const t = $(o).text().trim();
      if (t) additionalOffices.push(t);
    });
    const location = [...new Set([office, ...additionalOffices].filter(Boolean))].join('; ');

    const createdAt = pos.find('createdAt').first().text().trim();
    const posted = createdAt ? Date.parse(createdAt) : NaN;

    // Each <jobDescription> carries a <name> heading + <value> (HTML, often in
    // CDATA). Concatenate the sections into the job description text.
    const descParts: string[] = [];
    pos.find('jobDescription').each((_j, d) => {
      const value = $(d).find('value').first().text().trim();
      if (value) descParts.push(value);
    });
    const jd = htmlToText(descParts.join('\n\n'));

    jobs.push({
      external_id: id,
      title,
      url: `https://${host}/job/${encodeURIComponent(id)}?language=en`,
      company,
      location,
      jd_text: jd || undefined,
      posted_at: Number.isNaN(posted) ? null : posted,
    });
  });
  return jobs;
}

export class PersonioAdapter implements SourceAdapter {
  type = 'personio' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };
    assertValidSlug(identifier, 'Personio tenant slug');
    const host = `${identifier}.jobs.personio.de`;
    const feedUrl = `https://${host}/xml?language=en`;
    ctx.emitProgress(`Fetching ${display_name} (Personio)…`);

    const xml = await fetchText(feedUrl, { allowedHosts: [host], retries: 2 });
    const jobs = parsePersonioXml(xml, display_name, host);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
