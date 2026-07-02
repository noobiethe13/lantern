# Code-reviewer memory — lantern

Persistent review nits and judgment calls not captured in CLAUDE.md / known-issues.md.
Read before reviewing; update when the team accepts/rejects a finding.

- [Browser-tier SSRF redirect gap](browser-tier-ssrf-redirects.md) — assertSafeHttpUrl guards only the initial URL; page.goto follows redirects unguarded, unlike fetch's redirect:'error'
