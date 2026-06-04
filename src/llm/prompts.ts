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
  return `You convert natural-language job search criteria into a strict JSON filter.

User said: "${userText}"

Output ONLY this JSON shape (no markdown, no commentary):
{
  "title": {"positive": ["..."], "negative": ["..."]},
  "location": {"remote_required": <bool>, "allowed": ["..."]},
  "seniority": {"allowed": ["junior","mid","senior","staff","principal"]},
  "salary_min_usd": <int|null>,
  "exclude_companies": ["..."]
}

Rules:
- "Node developer" → positive includes "node", "javascript", "typescript"
- "no startups under N people" → leave for human; don't add to filter
- "remote" → remote_required: true`;
}
