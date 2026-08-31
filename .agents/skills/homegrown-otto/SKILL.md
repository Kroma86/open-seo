---
name: homegrown-otto
description: >
  HomeGrown OTTO (NiceSEO edge fix queue) and NiceSEO pixel status — never Search Atlas OTTO.
  Triggers: OTTO, HomeGrown, pixel, fix title/meta/H1/OG, queue SEO fixes, how are you connected
  to this site, where is OTTO/pixel, apply Safe SEO without Search Atlas,
  On-Page SEO Fix Critical Issues.
---

# HomeGrown OTTO + NiceSEO pixel (SAM)

## Goal

Drive **our** ops layer from chat: report OTTO queue + pixel status, and queue on-page fixes for Jon's Hermes gate. OpenSEO supplies facts. SAM proposes. Nothing goes live from chat.

## When to use

- OTTO / HomeGrown OTTO / "queue fixes" / fix title, meta, H1, OG
- NiceSEO pixel / beacon / "is the pixel live"
- "How are you connected to this site?" / "where is OTTO and pixel"
- Any ask that used to mean Search Atlas OTTO deploy

Score / pillars / "is my NiceSEO number real" is **not** this skill — activate `niceseo-pillars`.

## Do not

- Do not claim a fix is live on a client domain
- Do not call Search Atlas / SA OTTO tools
- Do not invent titles or descriptions — ground proposals in tools
- Do not attach Cloudflare routes or change worker bindings
- Do not invent pixel status — call `get_niceseo_ops_status`

## Tools

1. `get_niceseo_ops_status` — **call first** for OTTO queue counts + NiceSEO pixel status (read-only).
2. `get_agency_otto_page_inputs` — free DB read of latest audit page SEO fields (prefer for proposals).
3. `get_audit_issues` / `get_audit_pages` — if you need issue detail the otto export lacks.
4. `propose_homegrown_otto_fixes` — queue pending fixes (title, description, og_*, h1). **Pending only.**
5. `list_homegrown_otto_proposals` — confirm what is queued after propose.

## Workflow

### Status / "how connected" / pixel

1. Activate this skill.
2. Call `get_niceseo_ops_status` for the project domain.
3. Answer in plain English: OTTO queue (pending/pulled/rejected), pixel status + events if present.
4. Clarify: public fetch / DataForSEO / project memory are separate from HomeGrown OTTO and the NiceSEO pixel.

### Queue a fix

1. Call `get_niceseo_ops_status` (optional but preferred when the user asked about OTTO).
2. Load page inputs for the project domain.
3. Name the problem with evidence (current title length, missing description, etc.).
4. Propose concrete replacement strings (no placeholders).
5. Call `propose_homegrown_otto_fixes` with `before_*` fields filled from the audit.
6. Tell the user: queued for HomeGrown OTTO → Hermes pull → Jon's approval gate. Not live yet.
7. If they ask "is it live?", say only gate+apply on Hermes can make it live, and client routes still need Jon's explicit yes.

## Output

Keep it short: tool-backed status and/or proposal id + fields, and that approval is still required for live changes.
