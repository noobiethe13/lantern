// Find the first balanced JSON object or array in `s`. Scans for `{` or `[`,
// walks forward tracking depth, ignoring brackets inside strings. Returns the
// substring or null if no balanced block is found.
//
// Used as a defensive fallback when a model wraps its JSON output in prose
// despite explicit "only JSON" instructions (e.g. "Here is the response: {...}").
export function extractFirstJsonBlock(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// Strip a leading ```json (or plain ```) fence and a trailing ``` fence if
// present. Common when a model ignores "no markdown" instructions.
export function stripCodeFence(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}
