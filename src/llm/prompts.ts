const JD_PREVIEW_CHARS = 4096;

export function verdictPrompt(
  criteriaYaml: string,
  title: string,
  company: string,
  location: string,
  jdText: string
): string {
  const preview = jdText.slice(0, JD_PREVIEW_CHARS);
  return `Score this job against the user's criteria.

Criteria:
${criteriaYaml}

Job:
title: ${title}
company: ${company}
location: ${location}
description (first 4KB): ${preview}

Return ONLY this JSON:
{"fit":<bool>,"score":<0..1>,"seniority":"junior|mid|senior|staff|principal|unknown","stack_match":["..."],"remote_confirmed":<bool>,"salary_min_usd":<int|null>,"reasons":["1-3 short reasons"]}`;
}

export function nlFilterPrompt(userText: string): string {
  return `You convert a natural-language job search into a strict JSON filter.
The user typed a single search; extract every constraint they expressed and
nothing they did not.

User search: "${userText}"

Output ONLY this JSON (no markdown, no commentary):
{
  "title": {"positive": ["..."], "negative": ["..."]},
  "location": {"remote_required": <bool>, "allowed": ["..."]},
  "seniority": {"allowed": ["junior","mid","senior","staff","principal"]},
  "salary_min_usd": <int|null>,
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
- location.remote_required: true only if the user requires remote ("remote",
  "work from home", "wfh"). Naming a city does NOT set this.
- seniority.allowed: levels implied. "senior SRE" -> ["senior"]; "staff or
  principal" -> ["staff","principal"]. Empty if unstated.
- salary_min_usd: numeric USD floor if stated ("$100k" -> 100000, "120k+" ->
  120000); convert k/m suffixes and approximate other currencies to USD. null if
  unstated.
- exclude_companies: companies to avoid ("not Meta" -> ["meta"]). Empty if none.
- Ignore anything you cannot map to a field. Never invent constraints.`;
}
