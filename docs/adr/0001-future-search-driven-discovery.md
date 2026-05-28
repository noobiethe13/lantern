# ADR 0001 — Future: search-driven discovery

- **Status**: Proposed (placeholder, no design commitment)
- **Date**: 2026-05-28
- **Context source**: Phase 7 modernization (F18 in
  `C:\Users\Debayan\.claude\plans\review-this-repo-d-dev-sibling-tool-bright-book.md`)

## Context

lantern's current discovery surface is a fixed registry of source adapters
(`greenhouse`, `ashby`, `lever`, `hn-whos-hiring`, `generic-url`, `local-parser`).
Users seed companies by name; lantern fetches each board on a scan.

sibling-tool takes a different posture in the same space: it issues web searches
("$ROLE jobs at $COMPANY", "remote $STACK $YEAR") and parses the SERP via the
LLM. This surfaces companies that aren't yet seeded, including the long tail of
roles posted on bespoke ATSes lantern doesn't have an adapter for.

The two approaches are complementary, not mutually exclusive:

- **Seeded scans** (current) — high precision, predictable cost. Every job
  comes from a known board so the URL, ATS-specific salary fields, and
  posted-at timestamps are reliable.
- **Search-driven discovery** — high recall, ATS-agnostic, but cost scales
  with the search engine call and the post-search HTML extraction, which is
  noisier. Also raises rate-limit, attribution, and SERP-parsing fragility
  questions.

## Decision (deferred)

No commitment yet. This ADR exists so the idea isn't lost between sessions and
so future design work has an anchor. When this is picked up, the design should
answer:

1. **Search backend** — which provider (Google CSE, Brave Search API,
   DuckDuckGo HTML, Tavily, etc.)? Cost per query? Stability of contract?
2. **Adapter shape** — new `search` source type, or a discovery step that
   feeds the existing `generic-url` adapter?
3. **De-duplication** — search results overlap heavily with seeded boards;
   the F7 fuzzy dedup needs to absorb cross-source hits.
4. **L1 surface** — current L1 YAML rules apply post-extract; do they need a
   pre-extract filter (URL/title only) to keep search-broadcast costs sane?
5. **Liveness coupling** — search hits already passed an external recency
   filter; how does that interact with lantern's L2 → liveness deferral?
6. **Privacy / quota** — discovery queries broadcast role intent to a third
   party. Acceptable for the local-first single-user model, but worth
   documenting before adding.

## Alternatives considered

- **Status quo (no search)** — accepts that lantern misses long-tail roles.
  Lowest complexity, lowest cost, lowest recall.
- **Manual generic-url seeding** — power-user workaround. Works today but
  doesn't scale to "what's out there I don't know about?"
- **Subscribe to job aggregators** — defeats the local-first goal and adds
  per-aggregator parsing fragility.

## Consequences

If/when adopted: scan cost grows, dedup pressure increases, liveness logic may
need to learn about non-board sources, and the UI needs a way to surface
"discovered" jobs vs "seeded board" jobs distinctly (probably a badge).

If never adopted: lantern stays a precision-first tool. Users who want recall
add boards manually or use the `local-parser` source to bring their own
discovery layer.
