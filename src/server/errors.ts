import type { ZodError } from 'zod';

/** C3 error body contract: `error` is always a human-readable string. */
export interface ApiErrorBody {
  error: string;
  issues?: Array<{ path: string; message: string }>;
}

/**
 * Turns a ZodError into the C3 error body — a readable "path: message" summary
 * in `error` (so the UI never renders "[object Object]"), plus the structured
 * `issues` list for callers that want to highlight specific fields.
 */
export function zodErrorBody(err: ZodError): ApiErrorBody {
  const issues = err.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
  const error = issues.map(i => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ') || 'Invalid request';
  return { error, issues };
}

export type SourceFetchErrorKind =
  | 'http'      // Network / HTTP-level failure (timeout, DNS, 5xx, etc.)
  | 'gated'     // Host hard-blocks scraping (robots, captcha, anti-bot wall)
  | 'auth'      // Login wall or expired session
  | 'extract';  // Page reachable but content unusable (LLM extract failed)

export class SourceFetchError extends Error {
  readonly kind: SourceFetchErrorKind;

  constructor(kind: SourceFetchErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SourceFetchError';
    this.kind = kind;
  }
}

export function isSourceFetchError(err: unknown): err is SourceFetchError {
  return err instanceof Error && err.name === 'SourceFetchError';
}
