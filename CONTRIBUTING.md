# Contributing to Lantern

Thanks for your interest in Lantern. This guide covers how to get set up, what
the project values, and how to land a change.

## Getting set up

```bash
git clone https://github.com/noobiethe13/lantern.git
cd lantern
bun install
bun run dev        # server + Vite dev server, hot reload
bun test           # the test suite
```

You need [Bun](https://bun.sh) and, for anything that grades jobs or parses a
search, the [Claude Code](https://claude.com/claude-code) CLI on your `PATH`.
Read [docs/development.md](docs/development.md) for the project layout.

## Before you open a pull request

Run the checks locally. A change should keep all three green:

```bash
bun test               # unit tests
bunx tsc --noEmit      # type-check (covers the UI too)
bun run build:ui       # the UI builds
```

Migrations are not covered by the test suite. If you touch `src/db/`, verify
your change by running the migrations against an in-memory database (fresh,
legacy, and idempotent), as described in [docs/data-model.md](docs/data-model.md).

## What the project values

Lantern has a deliberate shape. A few principles are load-bearing, and a change
that breaks them will be sent back:

- **Local-first.** The server binds to `localhost` only. No search text or
  résumé leaves the machine except through the user's own Claude Code session.
- **Honest by default.** Signals are shown with their reasons. A "high"
  legitimacy badge means "no red flags found," never "verified real."
- **Deterministic where it can be.** Cheap rules do the heavy lifting; the
  language model is reserved for judgment that rules cannot make.
- **Streaming adapters.** Source adapters are async iterables so the runner can
  stream jobs into the database without buffering.
- **Every adapter keeps its SSRF guard.** Validate slugs, build the exact host,
  and allowlist it. Never fetch a user-supplied URL unguarded.

The full list of invariants lives in [`CLAUDE.md`](CLAUDE.md) under "Critical
rules." Skim it before a substantial change.

## Making a change

1. **Branch** off `main` with a short, descriptive name (`freshness-gate`, not
   `fix-1`).
2. **Keep the diff surgical.** Change as little as needed. Match the surrounding
   style rather than rewriting it. Surface unrelated issues separately instead of
   fixing them in passing.
3. **Add tests** for new logic in the core paths (filter, runner, adapters).
   Keep parse functions exported and unit-tested next to their adapter.
4. **Validate LLM output through zod.** Every model response is parsed against a
   schema in `src/llm/schemas.ts`.
5. **Comment the _why_, not the _what_.** Explain a decision that isn't obvious
   from the code; skip narration.

## Adding a source

Adding a company board to an existing type is a one-line change to
`src/config/seed-sources.yml`. Adding a new source _type_ touches several
files, and the walk-through is in [docs/sources.md](docs/sources.md).

## Commit and PR style

- Write commit messages in the imperative mood ("Add freshness gate", not
  "Added").
- Explain the motivation in the PR description, not just the mechanics.
- Link any issue the change closes.

## Reporting bugs and requesting features

Open an issue with enough detail to reproduce: what you searched, what you
expected, and what happened. Logs from the terminal running the server help.

Security issues follow a different path; see [SECURITY.md](SECURITY.md).
