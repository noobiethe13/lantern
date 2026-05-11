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

export function hnExtractorPrompt(commentText: string): string {
  return `This is a comment from Hacker News "Who's Hiring" thread. Extract job listings into JSON. If the comment is not a hiring post, return [].

Comment:
${commentText}

Return JSON array:
[{"company":"...","title":"...","location":"...","url":"...","remote":<bool>,"salary_min_usd":<int|null>,"jd_text":"..."}]

Rules:
- One company per array element. Multiple roles in one post = multiple entries.
- "url" is the apply link in the post; if absent return "".
- jd_text is the verbatim sub-section about that role.`;
}

export function htmlExtractorPrompt(content: string, baseUrl: string): string {
  return `Extract all distinct job listings from this HTML/text into a JSON array.
Schema: [{"company":"","title":"","location":"","url":"","remote":false,"salary_min_usd":null,"jd_text":""}]

If the page is a single job, return one element. If a list, return all.
If the page has no jobs (login wall, error, listing empty), return [].
URLs must be absolute (resolve relative to ${baseUrl}).

Page content:
---
${content}`;
}

export function xGrokExtractorPrompt(responseText: string): string {
  return `This is a response from the Grok AI assistant on X.com about job openings. Extract all distinct job listings into a JSON array.

Schema: [{"company":"","title":"","location":"","url":"","remote":false,"salary_min_usd":null,"jd_text":""}]

Rules:
- Extract only concrete job listings (company + role + apply link or post URL).
- If a post URL is mentioned but no direct apply link, use the post URL as "url".
- If no job listings are present, return [].
- "jd_text" is any role description text found in the response.
- "remote" is true if the listing explicitly says remote/distributed/anywhere.

Response text:
---
${responseText}`;
}
