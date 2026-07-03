// Score as heat, not verdict: a continuous ash → ember → gold ramp made by
// mixing two theme tokens in OKLCH (warm gray → bright amber passes through
// dim ember oranges on the way). Weak scores cool to near-gray so the page's
// visual energy is proportional to relevance; only strong fits glow. The
// s^1.4 easing keeps the low end ashy instead of linearly warm.
export function scoreColor(score: number): string {
  const s = Math.max(0, Math.min(1, score));
  const heat = Math.round(Math.pow(s, 1.4) * 100);
  return `color-mix(in oklch, var(--score-hot) ${heat}%, var(--score-ash))`;
}
