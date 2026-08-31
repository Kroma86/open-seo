---
name: striking-distance
description: >
  Keywords in positions 11–20 worth pushing to page one, with title/meta
  rewrite proposals. Search Atlas names: Keyword rank-slippage sibling;
  striking-distance content refresh (Coworker: pos 11–20, top five by
  traffic potential, title + meta rewrite). Use when: striking distance,
  page two keywords, near page one, title meta rewrite for near-rankers.
  Propose-only; HomeGrown OTTO gate applies.
---

# Striking distance (page-two push)

## Goal

Find keywords ranking roughly positions **11–20**, pick the **top 5** by
traffic potential, and propose title/meta rewrites to help them reach page
one. Propose only. Do not apply.

## NiceSEO gate

Until Jon names another cutover, run this only for **niceseo.ai**. Other
domains: still on Search Atlas. Do not invent positions or volumes.

Follow `niceseo-pillars` / `PILLAR-RULES.md` for Visibility if you mention the
ring. Rank rows with `position: null` are not measured zeros. Sibling skill
`rank-slippage` covers drops; this skill covers near-page-one opportunities.

## Tools

1. `get_niceseo_ops_status`
2. `get_rank_tracker` — free read; keep rows with position 11–20 only
3. `get_search_console_performance` — free if GSC is connected; filter client-side
   to average position ~11–20 (high `rowLimit`; API sorts by clicks)
4. `get_keyword_metrics` — paid; only if Jon asked spend this turn (label it)
5. `get_agency_otto_page_inputs` / `get_audit_pages` — current title/meta proof
6. `propose_homegrown_otto_fixes` — **pending only**, only if Jon asked to queue

## Workflow

1. Confirm niceseo.ai. If not, stop.
2. Collect candidates:
   - Rank tracker: numeric `position` in 11–20 (desktop/mobile as separate rows)
   - GSC: queries/pages with avg position in ~11–20 when connected
3. If neither source has candidates, say so. Do not invent a list.
4. Score potential from measured signals only: impressions, clicks, volume (if
   paid metrics were approved). Missing metrics → **Not measured**, still
   rankable by impressions when GSC exists.
5. Pick top **5**. For each, load current title/meta from audit/otto inputs.
6. Draft one-line title + meta rewrite grounded in the query and current copy.
7. Call `propose_homegrown_otto_fixes` only if Jon asked to queue this turn.
   Otherwise print the drafts and stop. Never claim live.

## Output

| Keyword / query | Source | Position | Potential proof | URL | Proposed title | Proposed meta |

Then: whether proposals were queued (pending) or text-only. Visibility bar only
if `PILLAR-RULES.md` formulas have real inputs; else omit the bar.

## Do not

- Do not print #0 for unranked terms
- Do not auto-deploy OTTO / apply fixes from chat
- Do not run `run_rank_tracker` unless Jon approved the credit estimate
- Do not invent traffic potential
- Do not write a full article here (hand off content drafting separately)
