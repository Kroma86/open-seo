---
name: brand-facts
description: Build and maintain one canonical brand-facts record for the current project — the source of truth for AI visibility, schema, and content consistency.
---

# Brand facts (one canonical record)

## Goal

Build and keep **one** brand-facts record for the current project. It is the
single source of truth that feeds AI visibility, schema markup, and content
consistency. Re-run this skill to update it; do not keep a second copy.

## Fields

Every fact carries exactly one provenance tag: `user-stated` (the user said it
in this conversation), `site-observed` (seen on a page of the project's own
site — name the URL), or `unconfirmed`. Never invent a tag.

Record: business name, legal name, site URL, one-paragraph description,
business type (**online** or **local**), address + phone (**local only**),
service list, service areas, social profile URLs, founding year, notable
proof points (awards, review counts).

## Tools

Free only. The project is always the one in the current context.

1. `get_project_context` — read any existing `brand-facts` customSection
2. `get_audit_pages` — titles, descriptions, and contact info on own pages
3. `update_project_context` — save under `{ customSection: "brand-facts" }`

Zero paid calls.

## Workflow

1. Call `get_project_context`. If a `brand-facts` customSection already exists,
   start from it — merge, do not blank it.
2. Call `get_audit_pages` and pull observable facts from the project's own
   pages (title, description, contact info where present). Tag those
   `site-observed` and name the URL.
3. List the gaps. Ask the user to confirm or fill them. Never guess.
4. Save the record with `update_project_context` under customSection
   `brand-facts`.
5. Offer two DRAFT outputs derived **only** from `user-stated` and
   `site-observed` facts: a draft `llms.txt` (plain-text brand summary for AI
   crawlers) and a draft JSON-LD `Organization` snippet — or `LocalBusiness`
   when the type is local.

If a site page disagrees with the stored record, show both and ask which is
right before saving.

## Honesty

- `unconfirmed` facts **never** appear in llms.txt or JSON-LD drafts. They
  appear only in the gaps list.
- Never invent an address, phone, founding year, award, or review count.
- If the site and the stored record disagree, show both and ask which is right.

## Output

Plain English (grade 9). Print the record, then the two drafts.

**Record** — each field with its provenance tag. Gaps listed separately.

**Draft `llms.txt`** — plain text, confirmed facts only.

**Draft JSON-LD** — `Organization` or `LocalBusiness`. Confirmed facts only.
Delivered in chat as a DRAFT. This skill never publishes, deploys, or writes
any file to a live site.

Also save: `{ customSection: "brand-facts", title: "Brand facts", content }`

## Do not

- Do not publish, deploy, or write llms.txt / JSON-LD to a live site
- Do not invent NAP, founding year, awards, or review counts
- Do not put `unconfirmed` facts in either draft
- Do not spend credits (zero paid calls)
- Do not switch projects — always the one in the current context
