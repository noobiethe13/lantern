import { z } from 'zod';

// Master/baseline resume settings for triage scoring (L2 background-fit).
// Pure module — the DB-backed reader and routes live in routes/resume.ts; this
// stays importable by tests without touching db/client (which runs migrations
// at module load).
export const RESUME_TEXT_MAX = 50_000;

export const ResumeSettingsSchema = z.object({
  enabled: z.boolean(),
  text: z.string().max(RESUME_TEXT_MAX),
});

export type ResumeSettings = z.infer<typeof ResumeSettingsSchema>;

export const DEFAULT_RESUME_SETTINGS: ResumeSettings = { enabled: false, text: '' };

/**
 * Whether a settings change alters what L2 would see — the toggle flipped, or
 * the text changed while the feature is (or becomes) enabled. Effective
 * changes invalidate stored verdicts, same as a criteria change.
 */
export function resumeChangeAffectsVerdicts(prev: ResumeSettings, next: ResumeSettings): boolean {
  if (prev.enabled !== next.enabled) return true;
  return next.enabled && prev.text.trim() !== next.text.trim();
}
