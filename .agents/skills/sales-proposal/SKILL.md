---
name: sales-proposal
description: >
  Analyze a prospect domain and draft a plain-English sales proposal skeleton.
  Search Atlas names: Generate a sales proposal; Sales / General Sales
  Proposals. Use when: sales proposal, prospect audit pitch, gap analysis for
  a sales call, strategy roadmap for a lead. Research-only; never create
  projects; never spend beyond labeled research tools.
---

# Sales proposal (prospect research → skeleton)

## Goal

Analyze a **prospect** domain (site read + domain overview + gap vs their
competitors) and produce a plain-English proposal skeleton with a strategy
roadmap. Measured numbers only. Sources labeled. **Not measured** where absent.

## Scope gate

This skill is for a **named prospect domain**, not dogfood delivery on
niceseo.ai. Never run as a scheduled loop — the prospect domain must be
human-supplied each invocation. Do not create an OpenSEO project for the
prospect. Do not open an OTTO slot. Do not run `run_site_audit` on the session
project to “stand in” for the prospect — that audits the wrong site.

If Jon mentions NiceSEO scores for the prospect, follow `niceseo-pillars` /
`PILLAR-RULES.md`: no bar without source + proof; never invent Technical /
Visibility / Content / Authority / UX.

## Tools

Use **only** these, and label every paid call:

1. `map_links` / `read_pages` — free prospect site read (pass prospect domain/URLs)
2. `whoami` — credit balance before any paid call
3. Paid research (only if Jon asked spend this turn; label tool + domain):
   `get_domain_overview`, `get_ranked_keywords`, `find_serp_competitors`,
   `get_backlinks_overview`, `get_keyword_metrics`, `research_keywords`,
   `get_serp_results`
4. Optional local proof when the prospect is local and spend was approved:
   `search_local_businesses`, `get_local_serp_results`

Do **not** call: `run_site_audit`, `create_rank_tracker`, `run_rank_tracker`,
`save_keywords`, `propose_homegrown_otto_fixes`, `update_project_context` for
the prospect, or any project-creating path.

## Workflow

1. Require the prospect domain. If missing, ask once and stop.
2. Free path: `map_links` + `read_pages` on the prospect. Summarize what they
   sell, key pages, obvious on-page gaps — as observations, not invented scores.
3. If Jon approved paid research: `get_domain_overview` for the prospect;
   `find_serp_competitors` or named competitors; `get_ranked_keywords` for
   prospect + 1–2 competitors for a gap slice. Label each paid call.
4. Biggest pains, competitive threats, and opportunity — each tied to a measured
   number or marked **Not measured**.
5. Strategy roadmap (30/60/90-day style bullets). Plan only. No spend orders.
6. Stop. Do not create projects, buy links, launch ads, or queue OTTO.

## Output

Plain English (grade 9). Skeleton only:

1. **Prospect** — domain + one-line what they do (from pages read)
2. **Evidence** — table of metric | value or Not measured | source | date
3. **Pains** — 3–5, each with proof or Not measured
4. **Competitive gap** — vs named competitors; keyword/authority claims only
   when fetched
5. **Roadmap** — prioritize technical hygiene, content/topics, authority/local
   as the evidence supports
6. **Spend used this turn** — list paid tools, or “free path only”

Any NiceSEO-style bar: only via `PILLAR-RULES.md` formulas with real inputs;
otherwise omit the bar and say **Not measured**.

## Do not

- Do not create projects or OTTO slots for the prospect
- Do not invent traffic, ranks, referring domains, or pillar scores
- Do not copy Search Atlas OTTO / Site Explorer scores
- Do not spend beyond the labeled research tools above
- Do not run session-project audits/rank checks as if they were the prospect
