---
name: homegrown-otto
description: "Hand on-page SEO fixes to HomeGrown OTTO (edge deploy engine) through the approval gate — never Search Atlas OTTO."
---

# HomeGrown OTTO (SAM)

## Goal

When the user wants SEO title/meta/H1/OG fixes applied on a site, **HomeGrown OTTO does the work**. OpenSEO supplies the facts. You (SAM) propose. Jon's gate approves. Nothing auto-deploys to client routes from chat.

## When to use

- "Fix the title/meta on this site"
- "Queue OTTO fixes"
- "Apply Safe SEO fixes without Search Atlas"
- Any request that used to mean Search Atlas OTTO deploy

## Do not

- Do not claim a fix is live on a client domain
- Do not call Search Atlas / SA OTTO tools
- Do not invent titles or descriptions — ground proposals in `get_agency_otto_page_inputs` or `get_audit_pages` / `get_audit_issues`
- Do not attach Cloudflare routes or change worker bindings

## Tools

1. `get_agency_otto_page_inputs` — free DB read of latest audit page SEO fields (prefer this).
2. `get_audit_issues` / `get_audit_pages` — if you need issue detail the otto export lacks.
3. `propose_homegrown_otto_fixes` — queue pending fixes (title, description, og_*, h1). Returns a proposal id. **Pending only.**
4. `list_homegrown_otto_proposals` — confirm what is queued.

## Workflow

1. Load page inputs for the project domain.
2. Name the problem with evidence (current title length, missing description, etc.).
3. Propose concrete replacement strings (no placeholders).
4. Call `propose_homegrown_otto_fixes` with `before_*` fields filled from the audit.
5. Tell the user: queued for HomeGrown OTTO → Hermes pull → Jon's approval gate. Not live yet.
6. If they ask "is it live?", say only gate+apply on Hermes can make it live, and client routes still need Jon's explicit yes.

## Output

Keep it short: what you found, what you queued (proposal id + fields), and that approval is still required.
