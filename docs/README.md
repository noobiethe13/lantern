# Lantern documentation

Reference material for understanding, running, and extending Lantern. If you are
just getting started, the [project README](../README.md) has the quickstart.

## Contents

- **[Architecture](architecture.md)** — the system at a glance, the scan
  lifecycle, and how the components fit together.
- **[Sources](sources.md)** — the adapter contract, the two kinds of source, the
  SSRF guard, and the board catalog.
- **[Filtering & ranking](filtering-and-ranking.md)** — the two-tier filter, the
  seniority and freshness gates, and how results are ordered.
- **[Ghost-job detection](ghost-jobs.md)** — the legitimacy scorer, its signals,
  and how to read the badge.
- **[Semantic intelligence](intelligence.md)** — the on-device embedding model
  and the four features built on it.
- **[Browser tier](browser-tier.md)** — the optional, deterministic browser
  engine, why it exists, and where it is allowed to run.
- **[LLM provider](llm-provider.md)** — the Claude Code integration, the prompts,
  and schema validation.
- **[Data model](data-model.md)** — the SQLite schema, migrations, and settings.
- **[Development](development.md)** — project layout, testing, and adding a source.

## Design principles

Everything in Lantern follows from a few commitments:

- **Local-first.** The server binds to `localhost`. Your data stays on disk.
- **Deterministic first, model second.** Cheap rules discard the bulk of results;
  the language model is reserved for judgment.
- **Honest signals.** Every score shows its reasons. Absence of a red flag is
  never dressed up as verification.
- **Streaming, not buffering.** Jobs flow through the pipeline as they arrive.
