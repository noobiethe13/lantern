---
name: browser-tier-ssrf-redirects
description: The browser tier (renderPage) guards only the initial URL; browser navigation follows redirects to private/metadata hosts unguarded, unlike core/fetch
metadata:
  type: project
---

`src/runner/browser.ts` `renderPage()` calls `assertSafeHttpUrl(url)` on the
**initial** URL only, then `page.goto(url)`. A browser navigation follows 3xx
redirects by default, so a public URL that 302-redirects to
`http://169.254.169.254/` (cloud metadata) or `http://127.0.0.1:...` reaches a
private host — the exact SSRF the fetch path blocks with `redirect:'error'`
(`core/fetch.ts` `buildRequestInit`).

**Why:** ADR 0003 item 4 explicitly requires "no following to
private/loopback/metadata IPs," so this is a stated invariant the seam must
honor, not just defense-in-depth. The browser tier is fed URLs from
google_jobs / indeed / paste-a-URL — attacker-influenceable surfaces.

**How to apply:** When reviewing any `renderPage`/browser-nav change, check that
redirects are either blocked or re-validated against `assertSafeHttpUrl` (e.g.
a request interceptor / `route` handler, or re-checking `response.url` /
`page.url()` post-nav and discarding private-host landings). Flag as Critical
until the seam re-validates the post-redirect host. Note `core/liveness.ts`'s
private `isSpaHost` is the kind of host gate the browser fallback was specced to
use but currently doesn't.
