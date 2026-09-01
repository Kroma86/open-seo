---
name: ai-visibility
description: >
  Measure whether AI chat tools mention this brand, and name content gaps.
  Search Atlas names: AI Visibility — Find Content Opportunities; Analyze Citation Gaps.
  Use when: ChatGPT mentions, AI Overviews, AEO, GEO, LLM visibility, citation gaps.
  Do not use for paid amplification or prompt-config writes unless Jon asked.
---

# AI visibility opportunities

## Goal

Say whether AI tools mention this site, and what topic to write next. Measure first. Do not pretend we ran a campaign.

## NiceSEO gate

Until Jon names another cutover, run this only for the house domains **niceseo.ai**, **twa.studio**, and **niceapp.ai**. Other domains: still on Search Atlas. Do not invent mention counts.

Follow `niceseo-pillars`. Do not call paid DataForSEO LLM indexes unless Jon asked this turn. If he did not, report only what OpenSEO already has, or **Not measured**.

## Tools

1. `get_niceseo_ops_status`
2. `get_search_console_performance` — queries people already type (free if GSC is connected)
3. `get_audit_pages` — which pages exist to be cited
4. `list_saved_keywords` — topics we already track
5. Paid LLM mention tools are **not** in SAM. Do not invent a mention rate.

## Workflow

1. Confirm the project domain is niceseo.ai, twa.studio, or niceapp.ai. If not, stop.
2. Pixel + GSC as connection proof. GA4 property Niceapp.ai is not proof for this site.
3. From GSC (if connected), list 3 to 5 questions a customer would ask ChatGPT that match real queries.
4. Check whether we have a page that answers each question (`get_audit_pages` / key pages in project context).
5. If no mention index was queried this turn, AI mention rate is **Not measured**. A stored 0 from a dated DataForSEO pull may be used only if the skill that stored it named the source and date.

## Output

- Mention index: number + source + date, or Not measured
- 3 to 5 question gaps, each with an existing URL or “no page yet”
- One writing task for this week (do not publish it)

## Do not

- Do not edit AI-tracking config
- Do not create llms.txt from this skill (that is a separate yes)
- Do not quote Search Atlas AI Visibility 2.5K-style counts
