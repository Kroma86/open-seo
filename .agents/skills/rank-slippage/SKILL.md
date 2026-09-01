---
name: rank-slippage
description: >
  Read OpenSEO rank tracker rows and say which keywords moved. Search Atlas
  names: Keyword Rank-Slippage Alert; Ranking-Drop Early Warning.
  Use when: rank drop, keyword slipped, did we fall, rank tracker check.
  Null position is not rank 0.
---

# Rank slippage (read)

## Goal

Compare the latest rank-tracker snapshot to the previous one. Alert only when a real position got worse.

## NiceSEO gate

Until Jon names another cutover, run this only for the house domains **niceseo.ai**, **twa.studio**, and **niceapp.ai**, or a project Jon has enabled for loops. Other domains: still on Search Atlas.

Follow `niceseo-pillars` for Visibility. Do not run a live rank check unless Jon approved `estimate_rank_tracker_cost` this turn.

## Tools

1. `get_niceseo_ops_status`
2. `get_rank_tracker` — config + latest rows. Free to read.
3. `get_search_console_performance` — site average position (free if GSC is connected). This is Visibility, not a keyword rank.
4. `estimate_rank_tracker_cost` / `run_rank_tracker` — only after Jon says yes to the credit amount. Pass that amount as `maxCostCredits`.

## Workflow

1. Confirm the project domain is niceseo.ai, twa.studio, or niceapp.ai, or a project Jon has enabled for loops. If not, stop.
2. `get_rank_tracker`. If `lastCheckedAt` is null, say ranks have never been checked. Do not invent positions.
3. For each keyword, desktop and mobile:
   - `position` is a number → report it
   - `position` is null → **not in the search depth** (not #0)
4. Slippage: previous position was a number AND new position is a worse number, or went from a number to null. Default alert if drop ≥ 3 places.
5. Do not start a new check unless asked. If asked, estimate first, show dollars/credits, wait for yes.

## Output

| Keyword | Device | Now | Previous | Change |
|---|---|---|---|---|

Then: GSC average position if connected (Visibility proof). Keywords with no position: count them as tracked, not as zeros.

## Do not

- Do not print #0 for unranked terms
- Do not spend rank-check credits without a yes
- Do not use Search Atlas rank tables
