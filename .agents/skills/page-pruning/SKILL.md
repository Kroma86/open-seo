---
name: page-pruning
description: >
  Find prune / noindex / merge candidates on the current project's site:
  thin pages, orphans, decayed traffic, near-duplicates. Use when: page
  pruning, thin content, orphan pages, decayed pages, near-duplicate URLs.
  Recommends only; never deletes, noindexes, or deploys.
---

# Page pruning (recommend only)

## Goal

Find pages on **this project's site** that should be pruned, noindexed,
merged, or watched. Candidates: thin pages, orphan pages (no internal
links pointing in), decayed pages (traffic fell), near-duplicate pages.
The site is always the project already in context. Never pick a different
domain. Recommend only.

## Tools (free project data only)

Use **only** these. All are free. Make zero paid calls.

1. `get_project_context` — confirm the current project; do not choose a site
2. `get_audit_pages` — per-page word counts, titles, status
3. `get_search_console_performance` — page-level clicks/impressions; **state
   the date window used** (default last 28 days when that is what the tool
   returned)
4. `map_links` — inbound internal links; orphans = zero inbound internal links
5. `update_project_context` — save the table (`customSection: "page-pruning"`)

## Workflow

1. `get_project_context`. Work on that project only. If none is in context,
   stop and say so.
2. `get_audit_pages` for word counts, titles, and status. Thin = low word
   count from this tool. Near-duplicate = same or near-same title on more
   than one URL from this tool.
3. `get_search_console_performance` for page-level clicks and impressions.
   State the date window in every traffic cell. Decayed = clicks fell vs a
   prior window **you also fetched**. A single window is not a drop.
4. `map_links`. Orphan = a crawled page with **zero** inbound internal links.
5. Classify every candidate. Every row needs evidence: the numbers + which
   tool returned them + the date window.

## Verdict classes

Every row uses one of: `prune`, `noindex`, `merge into <url>`, `keep-watch`.
`merge into <url>` must name a live URL from `get_audit_pages`. Stronger
verdicts need measured traffic; see Honesty.

## Honesty

- Every number states its source and date window.
- If Search Console is not connected, the traffic column reads **not
  measured** and **no verdict stronger than `keep-watch`** is allowed:
  prune / noindex / merge need traffic proof this skill cannot invent.
- Anything the tools did not return is **not measured** — never estimated,
  never filled in.

## Output

Plain English (grade 9). Short sentences. No jargon. Print the table, then
a short summary of what to do this week.

Save with `update_project_context`
`{ customSection: "page-pruning", title: "Page pruning", content }`.

| URL | Thin / orphan / decay / near-dup | Traffic (source + window) | Verdict | Evidence |

## Do not

- Do not delete, noindex, redirect, or deploy anything
- Do not make paid calls (the tools above are free project data)
- Do not pick a site other than the project in context
- Do not estimate missing word counts, links, or clicks
