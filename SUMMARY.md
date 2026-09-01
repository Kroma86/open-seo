# P6 agency home visual polish — SUMMARY

## Sparkline / traffic delta data availability

**Finding: no sparkline; no period-over-period delta on the portfolio table.**

`getAgencyHomePortfolio` calls `GscService.getPerformance` with `dimensions: ["date"]` server-side but **aggregates** clicks and impressions into `gscClicks28d` / `gscImpressions28d` only. The client receives scalar totals for the last 28 days — no time series and no prior-period comparison.

Other server functions (e.g. search performance) can return dated rows, but adding them would be a new fetch and was out of scope (client-only, no new queries).

**UI choice:** merged clicks + impressions into a single **Traffic** column with honest quiet states (`connect`, `not measured`, em dash). No fake sparklines or red/green deltas.

---

## Deliverables

### 1. Hero — rotating suggested asks

- `AgencyHomePromptBar` rotates the first five workflow chip prompts every 4.5s.
- Rotation pauses on focus and while the user types.
- Overlay placeholder (truncated) avoids layout shift; `aria-label` mirrors the active suggestion.
- Chip click still prefills via existing `initialPrompt` / `promptKey` handoff.

### 2. Portfolio table polish

- **Avatar:** `AgencyHomeProjectAvatar` — Google favicon (existing pattern) with `onError` fallback to deterministic letter-tile (initial + hue from domain/name hash).
- **Status pill:** `portfolioRowStatus()` from row fields only — GSC connected/not, measured clicks (`Live`), plus **Running** when a running mission exists for that project (cross-ref from already-fetched missions, no new API).
- **Traffic:** stacked clicks + impressions when measured; no sparkline or delta.
- **Interaction:** row hover, `tabular-nums`, drill-in `ChevronRight`, click navigates to project dashboard.
- **Setup:** GSC / Loops pills via shared `AgencyHomeStatusPill`.

### 3. Missions rail

- `AgencyHomeHorizontalScroll` — edge fades, hover scroll buttons, hidden scrollbar.
- Status pills aligned with portfolio (shared pill component + tones).
- Relative timestamps unchanged (`formatRelativeFinishedAt`).

### 4. Alerts card

- Logic unchanged.
- Severity counts use the same pill system as missions.
- Content wrapped in bordered card matching portfolio/missions loading shells.

### 5. Visual system

- Shared `AgencyHomeStatusPill` (success / warning / error / muted / info).
- Primary accent on prompt focus ring and hover chevrons; consistent `rounded-xl` cards and `gap-8` page rhythm.
- DaisyUI tokens only (`base-*`, `primary`, semantic success/warning/error) — works in light and dark via existing theme.

---

## Files touched

| File | Change |
|------|--------|
| `src/client/features/agency-home/AgencyHomePage.tsx` | Derive `runningProjectIds` from missions; pass to portfolio |
| `src/client/features/agency-home/AgencyHomePromptBar.tsx` | Rotating placeholder |
| `src/client/features/agency-home/AgencyHomePortfolioTable.tsx` | Avatars, status, traffic column, chevron, hover |
| `src/client/features/agency-home/AgencyHomeMissionsRail.tsx` | Horizontal scroll rail + shared pills |
| `src/client/features/agency-home/AgencyHomeAlertsCard.tsx` | Card shell + shared pills |
| `src/client/features/agency-home/agencyHomeUtils.ts` | `domainLetterTile`, `portfolioRowStatus` |
| `src/client/features/agency-home/AgencyHomeStatusPill.tsx` | **new** shared pill |
| `src/client/features/agency-home/AgencyHomeProjectAvatar.tsx` | **new** favicon + letter tile |
| `src/client/features/agency-home/AgencyHomeHorizontalScroll.tsx` | **new** scroll affordance |
| `src/client/features/agency-home/AgencyHomePage.test.ts` | Rotating prompt + letter-tile assertions |
| `SUMMARY.md` | This file |

---

## Screenshots-worthy notes (blind round)

- **Honesty headline:** “Every number here is measured — or explicitly not” under “Put Sam to work” — contrasts with Atlas-style fake metrics.
- **Rotating real asks** in the hero (full workflow prompts, not lorem) — same mental model as Atlas’s rotating suggestions.
- **Missions rail** reads like “Your Missions” — cards with color-coded run status and relative time.
- **Portfolio density:** favicon/letter avatars, status + setup pills, stacked traffic without fabricated charts.
- **Quiet states are visible:** `connect`, `not measured`, `—` — never zero placeholders.
- **Drill-in affordance:** every portfolio row has a hover chevron to the client workspace.

---

## Acceptance

- `npx vitest run` — 1251 passed
- `npx tsc --noEmit` — clean
- `npx vite build --mode selfhost` — succeeded
