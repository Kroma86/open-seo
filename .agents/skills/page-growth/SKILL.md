---
name: page-growth
description: >
  Find pages that can win more Google clicks. Search Atlas name: Site Explorer —
  Find Page Growth Opportunities. Use when: page growth, which pages to improve,
  GSC landing pages, near-ranking URLs, content opportunities on our own site.
---

# Page growth opportunities

## Goal

Name a short list of **our own pages** that can earn more Google clicks this month, with one next action each. Evidence first. No fake scores.

## NiceSEO gate

Do not refuse or stop based on the project domain. Do not invent numbers. Do not pull Search Atlas.

Follow `niceseo-pillars` if you mention a NiceSEO ring. HomeGrown OTTO is propose-only. Do not apply fixes. Do not call paid DataForSEO unless Jon asked this turn.

## Tools (SAM has these)

1. `get_niceseo_ops_status` — pixel live or not.
2. `get_search_console_performance` — free if GSC is connected. Last 28 days.
3. `get_search_opportunities` — only if GA4 on this project is the right property. Never use the Niceapp.ai GA4 property for niceseo.ai.
4. `get_audit_pages` / `get_audit_issues` — on-page proof for the URLs you name.
5. `get_rank_tracker` — only rows with a real position. `position: null` is not #0.

## Workflow

1. Do not stop based on domain.
2. Call `get_niceseo_ops_status`.
3. If GSC is connected, read `get_search_console_performance`. Prefer pages with impressions and a position worse than 10, or clicks that dropped.
4. If GSC is not connected, say **Not measured** for Google clicks. Do not guess.
5. Cross-check 3 to 7 candidate URLs with `get_audit_pages` (title, H1, indexable).
6. Rank-tracker positions are extra proof only when the number is real.

## Output

Plain English (grade 9). For each page:

- URL
- Why it can grow (GSC clicks / impressions / position, or Not measured)
- One next action (title, H1, or new supporting page). Queue OTTO only if Jon asked to propose.

Cap at 7 pages. Missing data stays blank, never zero.

## Do not

- Do not treat a 1-page crawl as a site inventory
- Do not copy Search Atlas Site Explorer scores
- Do not run `run_rank_tracker` unless Jon approved the credit estimate
