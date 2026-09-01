---
name: site-health
description: >
  Weekly read-only site health: crawl issues and what changed. Search Atlas
  names: Weekly Site Health Audit and Fix; Weekly Account Health Scan.
  Use when: weekly audit, site health scan, what broke this week.
  This skill does not deploy fixes. Queue OTTO only if Jon asked.
---

# Site health (read, do not auto-fix)

## Goal

Say what the latest OpenSEO crawl found, in plain English. Compare to the last completed audit when you have it. Do not auto-fix.

## NiceSEO gate

Until Jon names another cutover, run this only for the house domains **niceseo.ai**, **twa.studio**, and **niceapp.ai**. Other domains: still on Search Atlas.

Follow `niceseo-pillars`. A 1-page crawl is not Technical 100. `lighthouseSeoAvg` on 1 page is a checklist, not the ring.

## Tools

1. `get_niceseo_ops_status`
2. `get_audit_status` — latest crawl
3. `get_audit_issues` / `get_audit_pages`
4. `run_site_audit` — only if Jon asked for a fresh crawl this turn. Default Lighthouse off. `runLighthouse: true` only if he asked for performance depth. Min pages is the tool minimum; still treat 1 unique page as a checklist.
5. `propose_homegrown_otto_fixes` — only if Jon asked to queue, never apply

## Workflow

1. Confirm the project domain is niceseo.ai, twa.studio, or niceapp.ai. If not, stop.
2. Read the latest completed audit. If none, say so. Do not start a crawl unless asked.
3. List issues by type. Verify any issue you will act on against the live page.
4. If pages crawled is 1, say the crawler only saw the homepage (JavaScript site). Do not score Technical from that.
5. One do-this-week action. If it is title/meta/H1, offer to queue HomeGrown OTTO as pending.

## Output

- Crawl date, pages crawled, issue count
- Top 5 issues with URL proof
- Technical ring: Not measured unless a real multi-page Lighthouse SEO average exists
- One next action

## Do not

- Do not auto-deploy OTTO
- Do not use issue-density (`100 − issues/pages × 2`) as health
- Do not copy Search Atlas OTTO scores
