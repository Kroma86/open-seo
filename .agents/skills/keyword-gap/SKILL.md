---
name: keyword-gap
description: >
  Find keywords competitors rank for that we do not, then prioritize targets
  for topical maps. Search Atlas names: Analyze Organic Competitors (keyword
  gap drill-down); Keyword gap / competitor keywords. Use when: keyword gap,
  competitor keywords we miss, topical map seeds, what they rank for that we
  don't. Paid DataForSEO calls must be labeled.
---

# Keyword gap (competitor drill-down)

## Goal

Compare this project to 2–3 competitor domains and produce a short prioritized
target-keyword list that can seed topical maps. Evidence first. No fake scores.

## NiceSEO gate

Until Jon names another cutover, run this only for **niceseo.ai**. Other
domains: still on Search Atlas. Do not invent volume, KD, or ranks.

Follow `niceseo-pillars` / `PILLAR-RULES.md` if you mention a NiceSEO ring.
Keyword-gap numbers are **not** a pillar bar. Per pillar law: competitor
keyword gaps come from OpenSEO ranks with real positions, or labeled
DataForSEO Labs **only if Jon asked spend this turn**.

## Tools

1. `get_niceseo_ops_status`
2. `get_search_console_performance` — free if GSC is connected (our demand)
3. `get_rank_tracker` — free read; `position: null` is not #0
4. `list_saved_keywords` — avoid duplicates
5. Paid (label every call): `get_ranked_keywords`, `get_domain_overview`,
   `find_serp_competitors`, `get_keyword_metrics`, `research_keywords`,
   `get_domain_keyword_suggestions` — only after Jon asked spend this turn
6. `save_keywords` — only after explicit yes

## Workflow

1. Confirm niceseo.ai. If not, stop.
2. Name 2–3 competitors from the human this turn. If they did not name at least
   two, ask once or confirm candidates from a single labeled
   `find_serp_competitors` call (only if Jon asked spend this turn) — do not
   invent domains. Never treat `list_saved_keywords` as a competitor source
   (that tool lists keywords, not competitor domains).
3. Free path first: GSC queries + rank-tracker rows we already have. Say
   **Not measured** for any competitor-side metric you did not fetch.
4. If Jon approved paid research this turn: for each competitor, call
   `get_ranked_keywords` (and `get_domain_overview` only if useful). Label
   source + that credits were used.
5. Diff: terms competitors rank for (real position) that we lack in GSC /
   rank tracker / saved keywords. Drop brand-only and off-business terms.
6. Hydrate shortlist with `get_keyword_metrics` only if spend was approved;
   else leave volume/KD as **Not measured**.
7. Prioritize 10–20 targets for topical maps (theme → money term → supporting).
   Do not publish pages from this skill.

## Output

Plain English (grade 9).

- Competitors compared (domains)
- Table: Keyword | Why (competitor proof) | Our proof | Volume/KD or Not measured | Priority
- 3–5 topical-map themes the list feeds
- Paid calls used this turn (tool + domain), or “none — free path only”

## Do not

- Do not invent competitor ranks or volumes
- Do not call paid DataForSEO unless Jon asked this turn
- Do not treat `position: null` as #0
- Do not copy Search Atlas keyword-gap scores onto the board
- Do not create projects or save keywords without a yes
