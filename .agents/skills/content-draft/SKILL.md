---
name: content-draft
description: >
  Write an article draft in the house voice from a content brief (or from a
  target keyword, in which case produce the brief first). Delivers a DRAFT
  project doc for human review. Use when: write the article, draft the post,
  turn the brief into copy. Never publish.
---

# Content draft (human review only)

## Goal

Write the article from a **brief**, in house voice, and deliver it as a
**DRAFT** project doc. A human reviews and publishes. Sam does not.

## NiceSEO gate

Do not refuse or stop based on the project domain. A draft is **not** a Content pillar score.

## Parameter

Needs a brief (chat, paste, or custom section `content-brief-<slug>`). Keyword
only → run `content-brief` first, then draft. Neither → refuse and point at
`content-topical-map`. Never invent the topic.

## Hard rules (publishing)

Same standing refusal as `not-in-openseo` (Content — Automate SEO Content
Publishing / Distribute Blog Content / Website Studio): never publish; never
call any publishing or CMS tool; never claim the draft is reviewed;
publishing stays a human action. End with: “DRAFT for human review. Not
published.”

## Voice (embed; do not soften)

- Short sentences
- Plain words
- Active voice
- Contractions are fine
- No “delve/unlock/leverage/elevate/robust/seamless”
- No “In today's …” openers
- No rhetorical-question openers
- No summary padding (“In conclusion”)
- Claims tied to the brief's sources — a claim with no source gets cut or
  marked [needs source]
- Final pass: re-read the draft sentence by sentence before finishing

Honor `writing_preferences` in project context (banned phrases, tone).

## Tools

1. `get_niceseo_ops_status`
2. Brief + project context. Do not re-fetch SERP unless the brief lacks it
   and the user explicitly accepted the credit cost this turn — then run
   `content-brief`, do not draft
   on an empty SERP
3. `map_links` / `get_audit_pages` only to confirm brief internal-link URLs
4. `update_project_context` — save the DRAFT (`customSection`);
   `appendResearchLog` if this turn spent credits
5. No HighLevel / Website Studio / CMS tool — do not pretend one ran

## Workflow

1. Do not stop based on domain. Load or produce the brief. Refuse if no target.
2. Draft to the outline, entities, questions, and word-count **range**. No pad.
3. Internal links only to URLs the brief named (our pages).
4. Cut or mark [needs source] any unsourced claim.
5. Re-read sentence by sentence. Fix clunk, banned words, openers, padding.
6. Save `{ customSection: "content-draft-<slug>", title: "DRAFT: <keyword>",
   content }`. Cap ~4,000 chars: if longer, store outline + opening and keep
   the **full** draft in chat. Never silently truncate.

## Output

Full draft in chat; DRAFT custom section (or pointer if over cap); sources
from the brief only. “DRAFT for human review. Not published.”

## Do not

- Do not publish, auto-post, or call a CMS
- Do not claim a human reviewed it
- Do not invent stats, quotes, or case studies
- Do not open with “In today's…” or a rhetorical question
- Do not spend DataForSEO unless producing a missing brief and the user
  explicitly accepted the cost this turn
