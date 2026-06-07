// Perceptual red → amber → green ramp in OKLCH. Fixed lightness/chroma so it
// reads on both light and dark fields; hue carries the signal.
export function scoreColor(score: number): string {
  const s = Math.max(0, Math.min(1, score));
  const hue = 25 + s * (148 - 25); // 25 (red) → 148 (green), passing ~86 amber
  return `oklch(0.64 0.16 ${hue.toFixed(0)})`;
}
