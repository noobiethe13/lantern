import { assertSafeHttpUrl } from '../core/fetch';

// Lazy, optional, deterministic browser tier. Patchright (an anti-detection
// Playwright fork) is an OPTIONAL dependency loaded ONLY via a dynamic import the
// first time a browser-requiring feature actually runs. A default install never
// pulls it and never loads the engine; when it's absent, every function here
// degrades gracefully (returns null / false) instead of erroring. Deterministic
// use only — navigate, wait, read fixed selectors. No screenshots or DOM are ever
// fed to an LLM. This is the single seam through which a browser engine may be
// named; the no-static-import contract is enforced by liveness.test.ts. See
// ADR 0003 in the session notes for the rationale and the scoped reversal of the
// old "no headless browser anywhere" rule.
//
// Install to enable (one-time, opt-in): `bun add patchright && bunx patchright
// install chromium`. Absent that, the tier stays inert.

// Annotated `string` (not the literal type) so tsc treats `import(ENGINE_MODULE)`
// as Promise<any> and does NOT try to resolve the possibly-uninstalled optional
// module at build time.
const ENGINE_MODULE: string = 'patchright';
const NAV_TIMEOUT_MS = 25_000;

// The optional engine ships no types in a default install; `any` is deliberate
// and confined to this seam.
type AnyModule = any;

let enginePromise: Promise<AnyModule | null> | undefined;

async function loadEngine(): Promise<AnyModule | null> {
  if (enginePromise === undefined) {
    enginePromise = import(ENGINE_MODULE).catch(() => null);
  }
  return enginePromise;
}

function getChromium(engine: AnyModule | null): AnyModule | null {
  return engine?.chromium ?? engine?.default?.chromium ?? null;
}

/**
 * Whether a request URL is allowed during navigation. Non-network schemes
 * (data:/blob:/about:) are not SSRF vectors and pass; http(s) URLs must clear the
 * same host checks as core/fetch. Used to abort redirect/subresource requests to
 * private/loopback/metadata hosts at request time — `assertSafeHttpUrl` on the
 * initial URL alone can't stop a public URL that 3xx-redirects to 169.254.169.254.
 */
export function isRequestAllowed(reqUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(reqUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  try {
    assertSafeHttpUrl(reqUrl);
    return true;
  } catch {
    return false;
  }
}

/** Whether the optional browser engine is installed and loadable. */
export async function isBrowserAvailable(): Promise<boolean> {
  return getChromium(await loadEngine()) !== null;
}

export interface RenderedPage {
  html: string;
  finalUrl: string;
  status: number | null;
}

export interface RenderOptions {
  timeoutMs?: number;
  /** Wait for this selector before reading content (deterministic readiness). */
  waitForSelector?: string;
}

/**
 * Render `url` in an ephemeral headless context and return its final HTML.
 * Returns null when the engine isn't installed or navigation fails — callers must
 * treat null as "unavailable", never as an error. SSRF: the URL passes the same
 * host checks as core/fetch before any navigation (a browser nav is an outbound
 * request too); an unsafe URL throws here exactly as it would in fetch. The
 * context is ephemeral (no persistent profile on disk) and torn down deterministically.
 */
export async function renderPage(url: string, opts: RenderOptions = {}): Promise<RenderedPage | null> {
  assertSafeHttpUrl(url);
  const chromium = getChromium(await loadEngine());
  if (!chromium) return null;

  const timeout = opts.timeoutMs ?? NAV_TIMEOUT_MS;
  let browser: AnyModule | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    // SSRF: assertSafeHttpUrl vetted only the initial URL. A redirect or subresource
    // could still target a private/loopback/metadata host, so abort every request to
    // a disallowed host at request time (before it leaves the browser).
    await context.route('**/*', (route: AnyModule) => {
      if (isRequestAllowed(route.request().url())) route.continue().catch(() => {});
      else route.abort().catch(() => {});
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    // Defense in depth: drop the result if the final URL resolved to a disallowed host.
    if (!isRequestAllowed(page.url())) return null;
    if (opts.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout }).catch(() => {});
    }
    const html: string = await page.content();
    const finalUrl: string = page.url();
    const status: number | null = response ? response.status() : null;
    return { html, finalUrl, status };
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
