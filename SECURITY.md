# Security Policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue for a
vulnerability.

Email **debayancodes@gmail.com** with:

- a description of the issue and the impact you see,
- the steps or proof-of-concept needed to reproduce it,
- the affected file(s) or endpoint(s) if you know them.

You can expect an acknowledgement within a few days. Once a fix is ready,
the report will be credited unless you prefer to stay anonymous.

## Scope

Lantern is a single-user, local-first application that binds to `localhost`.
The surfaces most worth scrutiny:

- **The Claude Code subprocess** (`src/llm/providers/claude-code.ts`), specifically
  argument construction and prompt handling.
- **Source adapters** (`src/sources/*`), where every network fetch runs behind an
  SSRF guard (slug validation, host allowlist, no redirect following). A bypass
  is in scope.
- **Prompt injection.** Scraped job descriptions are untrusted input. They are
  length-capped and sanitized before reaching a prompt. A way around that cap is
  in scope.
- **Attachment uploads**, meaning résumé and cover-letter handling (path traversal,
  content-type, size).
- **The local HTTP server**, and anything that would expose it beyond `localhost`
  or leak internal state.

## Out of scope

- Findings that require an attacker to already control the user's machine.
- The undocumented public job-board endpoints Lantern reads. Their availability
  and terms are the boards' own; Lantern makes light, single-user requests.
- Denial of service from pointing Lantern at an enormous board.

## Good practice for users

- Keep the server on `localhost`. Do not put it behind a public reverse proxy.
- Treat `data/` as private, since it holds your jobs, résumé, and settings.
