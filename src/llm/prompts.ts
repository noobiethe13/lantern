const JD_PREVIEW_CHARS = 4096;
// Resume text is user-typed (not scraped), but cap it anyway — it bounds cost
// and keeps the prompt-size contract predictable across batches.
const RESUME_PREVIEW_CHARS = 8192;

export interface BatchVerdictJob {
  id: number;
  title: string;
  company: string;
  location: string;
  jdText: string;
}

// Grades many jobs in one call against the same criteria. The per-job
// description is the bulk of the input, so it's capped per job (JD_PREVIEW_CHARS)
// — both to bound cost and as the injection-length guard (Critical rule §8).
// When resumeText is given, each verdict additionally grades background fit
// against it (sub-score + gaps) WITHOUT changing how the criteria score is
// judged — the criteria-only output must stay comparable across both modes.
export function batchVerdictPrompt(
  criteriaYaml: string,
  jobs: BatchVerdictJob[],
  resumeText?: string,
): string {
  const jobBlocks = jobs
    .map(
      (j) => `--- job_id: ${j.id}
title: ${j.title}
company: ${j.company}
location: ${j.location}
description (first 4KB): ${j.jdText.slice(0, JD_PREVIEW_CHARS)}`,
    )
    .join('\n\n');

  const resumeBlock = resumeText
    ? `

Candidate resume (for background_fit/gaps ONLY — it must not influence fit/score,
which are judged against the criteria exactly as if no resume were given):
${resumeText.slice(0, RESUME_PREVIEW_CHARS)}`
    : '';

  const resumeFields = resumeText
    ? `,"background_fit":<0..1 how well the candidate's background matches this job's requirements>,"gaps":["0-4 short missing-qualification notes"]`
    : '';

  return `Score each job below against the user's criteria. Grade every job
independently — judge each only on its own title/company/location/description.${resumeBlock}

Criteria:
${criteriaYaml}

Jobs (${jobs.length}):
${jobBlocks}

Return ONLY this JSON, with one entry per job, echoing each job_id exactly:
{"verdicts":[{"job_id":<int>,"fit":<bool>,"score":<0..1>,"seniority":"junior|mid|senior|staff|principal|unknown","stack_match":["..."],"remote_confirmed":<bool>,"salary_min_usd":<int|null>,"reasons":["1-3 short reasons"]${resumeFields}}]}`;
}

export function nlFilterPrompt(userText: string): string {
  return `You convert a natural-language job search into a strict JSON filter.
The user typed a single search; extract every constraint they expressed and
nothing they did not.

User search: "${userText}"

Output ONLY this JSON (no markdown, no commentary):
{
  "title": {"positive": ["..."], "negative": ["..."]},
  "location": {"remote_required": <bool>, "allowed": ["..."], "block": ["..."], "always_allow": ["..."]},
  "seniority": {"allowed": ["junior","mid","senior","staff","principal"]},
  "salary_min_usd": <int|null>,
  "salary_currency": "<ISO code, e.g. USD/EUR/GBP/INR>",
  "exclude_companies": ["..."]
}

Extraction rules:
- title.positive: the role plus its common synonyms/stack, lowercase and
  title-substring-matchable. "Node developer" -> ["node","node.js","backend",
  "javascript","typescript"]; "SRE" -> ["sre","site reliability","devops",
  "platform"].
- title.negative: roles to exclude. "no management" -> ["manager","lead","head of"].
- location.allowed: places the user named, with common variants. "in the UK" ->
  ["uk","united kingdom","england","london"]. Empty array if none named.
- location.block: regions the user wants to EXCLUDE, with common variants.
  "nothing US-based" / "not in the US" -> ["united states","usa","us"]. This also
  catches geo-restricted remote roles. Empty array if none named.
- location.always_allow: the user's own region that must pass even when it shares
  a listing with a blocked region — typically their home base, and usually only
  when they also block elsewhere ("remote anywhere, I'm in India" with a US block
  -> ["india"]). Empty array if not stated. Don't invent one.
- location.remote_required: true only if the user requires remote ("remote",
  "work from home", "wfh"). Naming a city does NOT set this.
- seniority.allowed: levels implied. "senior SRE" -> ["senior"]; "staff or
  principal" -> ["staff","principal"]. A year-of-experience range maps to every
  level it spans, not just the lowest: "1-3 YoE" -> ["junior","mid"]; "3-6 years"
  -> ["mid","senior"]; "5+ years" -> ["senior","staff"]. Empty if unstated.
- salary_min_usd: the numeric salary floor if stated, in the currency the user
  used — do NOT convert between currencies. Expand k/m suffixes ("100k" -> 100000,
  "1.2m" -> 1200000). null if unstated. (The _usd suffix is legacy; the amount is
  native to salary_currency.)
- salary_currency: the ISO 4217 code for that floor. "$" or a bare number -> "USD";
  "€90k" -> "EUR"; "£80k" -> "GBP"; "₹20L"/"20 lakh" -> "INR" (and 20 lakh = 2000000).
  Default "USD" when no salary is stated or the currency is ambiguous.
- exclude_companies: companies to avoid ("not Meta" -> ["meta"]). Empty if none.
- Ignore anything you cannot map to a field. Never invent constraints.`;
}
