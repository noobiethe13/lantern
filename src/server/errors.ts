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
