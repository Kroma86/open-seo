---
name: content-brief
description: >
  Parameterized content brief for one target keyword: intent, SERP coverage
  and gaps, heading outline, entities and questions, internal-link targets,
  word-count range, labeled sources. Use when: content brief, article brief,
  outline for a keyword, what to cover. Never invent the target keyword.
---

# Content brief (one keyword)

## Goal

For **one supplied target keyword**, write a brief a human can draft from.
Typically the keyword comes from `content-topical-map`. Measured numbers only.
Sources labeled. **not measured** where absent.

## NiceSEO gate

Do not refuse or stop based on the project domain.

Follow `niceseo-pillars` / `PILLAR-RULES.md` if a ring comes up. A brief is
**not** a Content pillar score. Do not invent stats or difficulty scores.

## Parameter

Requires a **target keyword** named by the user in this request, or by
the running loop's own configuration. A topical-map row is only a
suggestion — you may cite one and ask, but the user must confirm it
before you proceed. Never select a target yourself, from the map or
anywhere else. If no target was named, **refuse**: point at
`content-topical-map` and stop.

## Tools

1. `get_niceseo_ops_status`
2. `list_saved_keywords` / `get_rank_tracker` / `get_search_console_performance`
   — our demand and current position (free; null position is **not ranking**)
3. `map_links` / `get_audit_pages` / key pages — internal-link targets on
   **our** tracked pages only
4. `whoami` before any paid call
5. Paid (label every call; spend approval means the user explicitly accepted a credit cost in this conversation turn — asking for this skill is never spend approval):
   `get_serp_results` (required to describe the SERP), `get_keyword_metrics`,
   `research_keywords`
6. `update_project_context` — save the brief (`customSection`);
   `appendResearchLog` if this turn spent credits

## Workflow

1. Do not stop based on domain. Confirm the target keyword. If missing, refuse (above).
2. Free path: our position, GSC demand, existing URLs. Read writing
   preferences from project context.
3. SERP: `get_serp_results` for this keyword only after spend yes. If spend
   was not approved, say you cannot ground coverage/gaps and stop — do not
   invent what the top results cover. Use organic rows (and `people_also_ask`
   only if that `type` is in the tool output).
4. Intent from `get_keyword_metrics` when fetched; else from SERP format
   (guide vs local pack vs product) labeled as observed, not a KD score.
5. Write the brief. Stop. Do not draft the article (`content-draft` does that).
   Do not publish.

## Output

Plain English (grade 9). Save with `update_project_context`
`{ customSection: "content-brief-<slug>", title: "Brief: <keyword>", content }`
(prose cap ~4,000 chars). Also print it.

- **Target** — keyword + our position or **not ranking**
- **Intent** — measured or observed from SERP; else **not measured**
- **SERP cover / miss** — table of real top results (rank, domain, title);
  gaps = topics none of them cover. (Only reachable after the SERP
  fetch — without it the skill already stopped at workflow step 3)
- **Heading outline** — H1 + H2s from those gaps and real questions, not a
  stock “Why it matters in 20XX” template
- **Entities and questions** — from the fetched SERP titles and PAA
  rows; saved/research terms may supplement, never substitute, the
  fetched SERP. Do not fabricate a quota
- **Internal links** — our tracked pages only (URL + why)
- **Word-count range** — **proposed**, from SERP shape (result count / type),
  never a fake competitor-average word count
- **Sources** — every number: tool + date, or **not measured**

## Do not

- Do not invent the target keyword
- Do not invent volume, KD, or competitor word counts
- Do not describe a SERP you did not fetch
- Do not publish or hand the brief to a CMS
- Do not spend DataForSEO unless the user explicitly accepted the cost
  this turn (asking for a brief is not spend approval)
