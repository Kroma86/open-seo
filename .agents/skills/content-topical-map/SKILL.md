---
name: content-topical-map
description: >
  From the project's tracked keywords, GSC queries, and Sam's keyword tools,
  build a pillar-and-cluster topical map with prioritized targets. Use when:
  topical map, content map, pillar and cluster, what to write next, content
  plan. Numbers only from real tool output.
---

# Content topical map (pillar + clusters)

## Goal

Build a **pillar-and-cluster** topical map from keywords we already track, GSC
queries, and (only if spend was approved) Sam's keyword tools. Prioritize
targets. Save the map as a project custom-section report. Do not publish pages.

A monthly Sam loop template for this map is a planned follow-up; this skill is
on-demand only.

## NiceSEO gate

Domain allowlisting is enforced outside this skill; do not refuse or stop based on domain alone. Do not invent volume, KD, or ranks.

Follow `niceseo-pillars` / `PILLAR-RULES.md` if a NiceSEO ring comes up. A map
is **not** a Content pillar score. `position: null` is not #0.

## Tools

1. `get_niceseo_ops_status`
2. `list_saved_keywords` — tracked terms
3. `get_rank_tracker` — free read; skip null positions
4. `get_search_console_performance` — free if GSC is connected (our demand)
5. `map_links` / `get_audit_pages` — which pages already exist
6. Paid (label every call; spend approval means the user explicitly accepted a credit cost in this conversation turn — asking for this skill is never spend approval):
   `research_keywords`, `get_keyword_metrics`, `get_domain_keyword_suggestions`
7. `update_project_context` — persist the map (`customSection`);
   `appendResearchLog` if this turn spent credits

## Workflow

1. Do not stop based on domain.
2. Read project context for business fit (goal, positioning, key pages).
3. Free path: union saved keywords + rank-tracker rows + GSC queries. Drop
   brand-only and off-business terms. Coverage from `map_links` / key pages.
4. Paid expansion only if the user explicitly accepted the credit cost
   this turn (the map request itself never counts); label source + credits.
5. Cluster into one pillar + supporting clusters by shared intent / head term
   (sibling of `keyword-clustering`, but this output is a writing plan, not a
   page-tag map). Name each cluster from its terms — no empty themes.
6. Score each target only from measured parts of **search demand × current
   position opportunity × business fit**. Missing volume or position →
   **not measured** for that factor; do not multiply a fake number. Rank the
   rest by the factors you have. Opportunity: **not ranking** or 11–20 beats a
   stable #1–3. Business fit must quote the saved context line that justifies it
   ("goal: …"); with no supporting context line, mark fit
   **not measured** and rank by the measured factors alone.
7. Save with `update_project_context`
   `{ customSection: "topical-map", title: "Topical map", content }`
   (prose cap ~4,000 chars — table first). Also print it in chat. Next writing
   target goes to `content-brief` — do not invent a keyword there.

## Output

Plain English (grade 9).

- Pillar (one) + supporting clusters (covered vs gap, from real URLs)
- Table: Keyword | Cluster | Intent | Monthly volume (source) | Position or **not ranking** | Why-now
- Priority order and which factors were measured
- Paid calls this turn, or “none — free path only”
- Pointer to the saved custom section (Context settings page)

Intent and volume only if a tool returned them; else **not measured**.

## Do not

- Do not invent volume, difficulty, or ranks
- Do not treat `position: null` as #0
- Do not create CMS pages or publish
- Do not add a monthly loop from this skill
- Do not spend DataForSEO unless the user explicitly accepted the cost
  this turn (asking for a map is not spend approval)
