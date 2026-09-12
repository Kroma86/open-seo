---
name: niceseo-pillars
description: >
  NiceSEO agency board pillar rules — Technical, Visibility, Content, Authority, UX.
  Triggers: NiceSEO score, pillars, why is my score, trust tier, core vs full,
  not connected, headline ring, niceseo.ai score, board accuracy.
---

# NiceSEO pillar rules (law for SAM)

These rules are **not suggestions**. They are how the agency board is allowed
to speak. If a number would violate a rule, do not say the number. Say
**Not measured** or **Not connected**.

Talk to Jon in plain English (grade 9). Never invent a metric. Call tools
before you quote a pillar.

**Always activate this skill** before answering a score / pillar / ring /
"is this number real" question. Then compute with the formulas below. Do not
improvise a different meaning for a bar.

## When to use

- NiceSEO score, ring, pillars, trust, core vs full
- "Why is this 94 / 0 / Incomplete?"
- "Is this number real?"
- Any agency-board accuracy question

## Tools (call before talking)

1. `get_agency_score_inputs` — OpenSEO facts for the domain (audit, ranks, backlinks, GSC connection + totals). Free. Prefer this over paid DataForSEO.
2. `get_niceseo_ops_status` — pixel live or not. Required before calling a site "connected."
3. `get_search_console_performance` — only if GSC is connected. Free. Last 28 days.

Do not use Search Atlas / OTTO `seo_score` as NiceSEO health.

---

## Compute (do this in order — no other math)

### 0. Connection

A site is **connected** if **at least one** is true:

- NiceSEO pixel status is `live` (beacons in the last 7 days), or
- Google Search Console is connected on the OpenSEO project, or
- Google Analytics 4 is connected on the OpenSEO project.

GA4 connection does **not** fill any pillar. GBP `dfs_local` does **not** count as connected.

If **not connected**:

- Headline = **0**
- Do **not** read Technical / Visibility / Content / Authority / UX
- Do **not** read keyword ranks, gaps, or backlink counts as board truth
- Say: not connected. Warehouse crawls are not a score we show.

0 here means "not wired," not "we measured health and it was zero."

### 1. Technical

**Question:** Can Google read and trust the page machinery?

```
IF audit.status is completed AND lighthouseSeoAvg is a number:
  Technical = lighthouseSeoAvg          # already 0–100
  source   = "OpenSEO Lighthouse SEO"
  proof    = capturedAt + pagesCrawled
ELSE IF a real Lighthouse SEO run was stored (local Chrome / PageSpeed):
  Technical = that SEO category 0–100
  source   = lighthouse_cli (or pagespeed_lighthouse_seo)
  proof    = fetchTime + form factor
ELSE:
  Technical = Not measured
```

**MUST NOT:** Search Atlas OTTO score. Issue-density `100 − (issues/pages)×2`. One-page crawl dressed up as 94 **or as Lighthouse SEO 100**. A homepage checklist (title, robots, viewport, HTTP 200) is `lighthouse_seo_checklist`, not the Technical bar. DataForSEO OnPage unless Jon asked spend this turn (then label `dfs_onpage_*`).

**0 vs blank:** 0 only if Lighthouse SEO actually returned 0.

### 2. Visibility

**Question:** Does Google actually show this site?

```
IF gsc.position is a number (last 28 days site totals):
  Visibility = max(0, 100 − position)
  source     = "Google Search Console"
  proof      = clicks, impressions, CTR, position, capturedAt (~3 day lag)
ELSE IF rank-tracker rows exist with numeric position:
  Visibility = average of max(0, 100 − position) for those rows only
  source     = "OpenSEO rank tracker"
  proof      = keyword + position list
ELSE:
  Visibility = Not measured
```

Ignore keywords with `position: null`. Empty lists are not 0.

**MUST NOT:** Search Atlas ranks. Counting unranked keywords as measured-zero.

### 3. Content

**Question:** Is the writing useful for the topics we want to win?

```
Content (the ring bar) = Not measured
```

Homepage **basics** (title, meta, H1, 300+ words) may be stored as `onpage_basics` 4/4. That is a checklist, **not** a 0–100 Content pillar. Never put 100 in the ring for “the page has a title.”

**MUST NOT:** Copy Technical into Content. Issue-density. Search Atlas content scores. A 100 from four easy boxes.

When Content is blank, the headline is **core** T+V+A only.

### 4. Authority

**Question:** How many **other websites** link here?

```
IF referringDomains is a number AND snapshot age ≤ 7 days:
  Authority = round(min(99, 20 × log10(referringDomains + 1) × 1.5), 1)
  source    = "OpenSEO backlink snapshot"
  proof     = the raw referringDomains count (always say it)
ELSE:
  Authority = Not measured
```

Snapshot with 0 referring domains → **0** (measured zero). No snapshot → blank.

**MUST NOT:** Search Atlas authority. A bar with no referring-domain count.

Paid DataForSEO referring domains only if Jon asked spend this turn, labeled `dfs`.

### 5. UX (not in the ring)

```
IF a real Lighthouse / PageSpeed score was stored:
  UX = that score
ELSE:
  UX = Not measured
```

Never invent 0.

### 6. Headline ring (only if connected)

```
IF Technical AND Visibility AND Authority are all numbers:
  headline = round( (0.30×T + 0.30×V + 0.15×A) / 0.75 , 1)
  badge    = Core T+V+A     # Content is blank, so never "full"
ELSE:
  headline = no number
  badge    = Incomplete
```

If a distinct (non-proxy) Content score ever exists **and** T, V, C, A are all numbers:

```
headline = round(0.30×T + 0.30×V + 0.25×C + 0.15×A, 1)
badge    = Full pillars
```

UX never enters the ring. Do not average whichever bars happen to exist.

---

## How SAM must speak a pillar

For each bar you mention, one line with all three:

1. The number **or** Not measured / Not connected
2. The source name in plain words
3. The proof (count, date, or GSC position)

Example: "Authority 32.4 from OpenSEO links: 11 other sites. Snapshot 30 Aug."

Example: "Visibility 36 from Google Search Console: average position 64, 0 clicks, 1 impression (28 days ending 28 Aug)."

If you cannot fill all three, you do not have a bar.

## niceseo.ai (dogfood)

- Connected: pixel live + GSC `sc-domain:niceseo.ai`.
- Technical **in the ring: Not measured.** Homepage Lighthouse SEO checklist was 100 on **1 page** — that is not site technical SEO. Say Pass/checklist, never “technicals are 100.”
- Visibility: GSC avg position 64 → **36**. 0 clicks / 1 impression.
- Content ring: **Not measured**. Homepage basics 4/4 is a checklist, not a 100.
- Authority: 11 referring domains → **32.4**.
- Headline: **core** T+V+A only (about 61). Not Full. UX 69 not in the ring.
- Do **not** use GA4 property **Niceapp.ai** (`properties/465708676`) as proof for this site.

## Search Atlas is off the board

Do not pull Search Atlas to fill these. Map the old surface to the named source, or blank.

| Search Atlas used to show | Board now |
|---|---|
| OTTO / site SEO score | NiceSEO pillars (this law) |
| Rank tracker | OpenSEO rank tracker rows with a position, else GSC avg position |
| Keyword gap / competitor keywords | OpenSEO ranks with positions, or labeled DataForSEO Labs if Jon asked spend. Warehouse leftover counts stay hidden. |
| Site audit score | OpenSEO Lighthouse SEO (`lighthouseSeoAvg`) |
| Backlinks / referring domains | OpenSEO backlink snapshot |
| Google Business | Native login still missing. A Maps search may be stored as `searched_none` or labeled `dfs_local`. Never attach a different business. |
| AI visibility / ChatGPT mentions | DataForSEO LLM mention index (`dfs_llm_mentions`). 0 is allowed if the index was queried. |
| Content / on-page quality | Homepage parse (title, meta, H1, 300+ words) |

## Do not

- Do not quote warehouse 94s as health
- Do not say "full" while Content is blank, a proxy, or a title/meta/H1 checklist
- Do not use the GA4 property named Niceapp.ai as proof for niceseo.ai
- Do not call DataForSEO unless Jon asked this turn
- Do not mix crawl math, Google ranks, and link counts into one bar
- Do not bring Search Atlas numbers back onto the board
- **Jon 2026-08-31:** Do not put a 100 in Content for “the page has a title.” Do not put Lighthouse SEO 100 in the Technical ring for a 1-page checklist. Do not say Technical 100 means we ran an SEO campaign. Homepage basics stay in `onpage_basics`. Lighthouse SEO on one page stays in `lighthouse_seo_checklist`. If Jon did no SEO work, do not make the board look like he did.
