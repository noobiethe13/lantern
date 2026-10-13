// Deterministic reader for "this employer will not sponsor a visa" in a job
// description. Used by L1 only when the search says the user needs sponsorship, and
// built to under-fire: a miss defers to L2, a false hit loses a job outright.

const VISA_WORD = String.raw`(?:visa|work|employment|immigration|employer|company|h ?1b)`;
// Words that may sit between a refusal ("do not") and "sponsor" without changing its
// meaning ("do not offer visa sponsorship"). Anything outside this set ("do not
// require", "do not hesitate", "do not offer relocation but ...") breaks the match.
const FILLER = String.raw`(?:(?:be|to|currently|able|offer|provide|providing|extend|support|consider|accept|visa|work|employment|immigration|h ?1b|h1b|permit|permits|for|any|the|a|relocation|assistance|or|and|eligible)\s+){0,5}`;
const REFUSAL = String.raw`(?:unable|not able|unwilling|not willing|not in a position|not currently able|not currently in a position|cannot|can not|cant|will not|would not|wont|do not|does not|dont|doesnt|did not|are not|is not|arent|isnt)`;
const SPONSORSHIP = String.raw`(?:${VISA_WORD}\s+)*sponsorship`;

const NEGATIVE: RegExp[] = [
  // "unable to sponsor", "does not offer visa sponsorship", "will not be able to sponsor"
  new RegExp(String.raw`\b${REFUSAL}\s+${FILLER}sponsor\w*`),
  // "no visa sponsorship" (but not "no sponsorship is required", which reads as a reassurance)
  new RegExp(String.raw`\bno\s+${SPONSORSHIP}\b(?!\s+(?:is\s+|are\s+)?(?:needed|required|necessary))`),
  new RegExp(String.raw`\bnot\s+eligible\s+for\s+${SPONSORSHIP}`),
  // "visa sponsorship is not available"
  new RegExp(String.raw`\bsponsorship\s+(?:is\s+|are\s+)?(?:not|isnt|arent)\s+(?:be\s+)?(?:available|offered|provided|possible|supported)\b`),
  new RegExp(String.raw`\bsponsorship\s+(?:will\s+not|wont|cannot|cant)\s+be\s+(?:offered|provided|available)\b`),
  // "authorized to work in the US without (the need for) visa sponsorship"
  new RegExp(
    String.raw`\b(?:authori[sz]ed|eligible|permitted|entitled|legally|right|must be able)\b[^.;!?]{0,50}?\bwork\b[^.;!?]{0,60}?\bwithout\s+(?:(?:the|any|a|need|needing|for|of|current|future|or|now|in|and)\s+|${VISA_WORD}\s+){0,8}sponsorship`,
  ),
  // "must not require sponsorship now or in the future"
  new RegExp(
    String.raw`\b(?:must|should|need to|needs to|have to|required to)\s+(?:not|never)\s+(?:currently\s+)?require\s+(?:(?:now|or|in|the|future|current|and|at|any|time|point)\s+|${VISA_WORD}\s+){0,8}sponsorship`,
  ),
  // "candidates who require sponsorship will not be considered"
  new RegExp(
    String.raw`\b(?:require|requires|requiring|need|needs|needing)\s+${SPONSORSHIP}\b[^.;!?]{0,50}?\b(?:will not|wont|are not|arent|cannot|cant|can not|not)\s+(?:be\s+)?(?:considered|eligible|accepted|supported)`,
  ),
  // "we are unable to consider candidates who require visa sponsorship"
  new RegExp(
    String.raw`\b(?:unable|not able|cannot|can not|cant|will not|wont|do not|does not|dont|doesnt)\s+(?:to\s+)?(?:consider|hire|accept|support)\s+(?:\w+\s+){0,4}?(?:who|that|requiring)\s+(?:\w+\s+){0,2}?(?:require|requires|requiring|need|needs|needing)\s+${SPONSORSHIP}`,
  ),
];

// Checked only after the negative spans are blanked out, so "does not offer
// sponsorship" can't count as the positive "offer sponsorship". Any surviving offer
// means the JD is mixed ("we cannot sponsor contractors but can sponsor employees")
// and is left to L2.
const POSITIVE: RegExp[] = [
  /\b(?:can|will|may|able to|happy to|willing to|glad to|offer|offers|offering|provide|provides|providing|support|supports|supporting|we)\s+(?:(?:also|gladly|visa|work|employment|immigration|h ?1b|and|relocation|assistance|to)\s+){0,4}?sponsor\w*/,
  /\bsponsorship\s+(?:is\s+|may\s+be\s+|will\s+be\s+|can\s+be\s+)?(?:available|offered|provided|possible|supported)\b/,
];

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['‘’´`]/g, '')
    .replace(/[-–—_/]+/g, ' ')
    .replace(/\n+/g, '. ')
    .replace(/[^a-z0-9 .,;:!?]+/g, ' ')
    .replace(/\s+/g, ' ');
}

// "sponsor" alone also means events, conferences and training budgets. A refusal
// counts only when its sentence is about immigration, or when "sponsor(ship)" ends
// the clause ("We are unable to sponsor.", "... at this time").
const IMMIGRATION_CONTEXT =
  /\b(?:visas?|immigration|work authori[sz]ation|work permits?|h ?1b|green cards?|right to work|authori[sz]ed to work|eligible to work|legally (?:able|entitled)|sponsorship for employment|employment sponsorship)\b/;
// Sponsoring a person (as opposed to an event or a budget) is immigration sponsorship.
const PERSON_OBJECT = /^\s*(?:any\s+)?(?:candidates?|applicants?|employees?|new hires?|individuals?|workers?|you)\b/;
const CLAUSE_END =
  /^\s*(?:(?:at this time|at the moment|currently|for this (?:role|position|job|opportunity)|for any (?:role|position)|now or in the future|in the future)\s*)*$/;

function aboutVisas(text: string, start: number, end: number): boolean {
  const before = Math.max(
    text.lastIndexOf('.', start),
    text.lastIndexOf(';', start),
    text.lastIndexOf('!', start),
    text.lastIndexOf('?', start),
  );
  const after = text.slice(end).search(/[.;!?]/);
  const sentenceEnd = after === -1 ? text.length : end + after;
  // A tail that starts a new clause (", but ...") also ends this one.
  const tail = text.slice(end, sentenceEnd).replace(/,.*$/, '');
  return (
    IMMIGRATION_CONTEXT.test(text.slice(before + 1, sentenceEnd)) ||
    CLAUSE_END.test(tail) ||
    PERSON_OBJECT.test(tail)
  );
}

/** The (normalized) phrase in `jdText` that explicitly refuses visa sponsorship, or
 *  null when it doesn't say so or also says sponsorship is available. */
export function explicitNoSponsorship(jdText: string | null | undefined): string | null {
  if (!jdText) return null;
  let text = normalize(jdText);
  let hit: string | null = null;
  for (const re of NEGATIVE) {
    const global = new RegExp(re.source, 'g');
    for (const m of text.matchAll(global)) {
      if (hit === null && aboutVisas(text, m.index!, m.index! + m[0].length)) hit = m[0].trim().slice(0, 80);
    }
    text = text.replace(global, ' ');
  }
  if (hit === null) return null;
  return POSITIVE.some((re) => re.test(text)) ? null : hit;
}
