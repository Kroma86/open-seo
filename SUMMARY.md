# Ops artifacts ingest + dashboard — build summary

## Files touched

### Schema & migrations
- `src/db/app.schema.ts` — `agencyOpsArtifacts` table (plain unique index on kind+sourceKey)
- `src/db/pg/app.schema.ts` — Postgres mirror
- `src/db/schema.ts` — export `agencyOpsArtifacts`
- `drizzle/0044_elite_thunderbolt.sql` + snapshot/journal (generated)
- `drizzle-pg/0022_numerous_silver_centurion.sql` + snapshot/journal (generated)

### Backend
- `src/server/features/agency/repositories/AgencyOpsArtifactsRepository.ts`
- `src/server/features/agency/AgencyOpsArtifactsService.ts`
- `src/routes/api/internal/agency-ops-artifacts.ts` (exported `handlePost`)
- `src/serverFunctions/agency-ops.ts`
- `src/types/schemas/agency-ops.ts`

### Frontend
- `src/client/features/agency-home/AgencyHomeAlertsCard.tsx`
- `src/client/features/agency-home/AgencyHomePage.tsx`
- `src/client/features/agency-ops/AgencyOpsPage.tsx`
- `src/routes/_app/operations.tsx`
- `src/client/navigation/items.ts` — `orgNavGroup` with Operations
- `src/client/components/Sidebar.tsx` — wire `orgNavGroup`
- `src/client/features/sam-loops/SamLoopsPage.tsx` — Markdown swap only (~line 566)
- `src/routeTree.gen.ts` (regenerated via `vite build`)

### Tests
- `src/routes/api/internal/agency-ops-artifacts.test.ts` (10 tests)
- `src/server/features/agency/AgencyOpsArtifactsService.test.ts` (6 tests)
- `src/client/features/agency-home/AgencyHomePage.test.ts` (updated mocks + Alerts assertion)

## Test counts
- **New tests:** 16 (10 route + 6 service)
- **Full suite:** 1245 passed (151 files)

## Gates
- `pnpm db:generate` — clean (migrations generated)
- `pnpm vitest run` — green (including `schema-parity.test.ts`)
- `pnpm tsc --noEmit` — clean

## Deviations
- **`orgNavGroup`:** No pre-existing org nav items were in `items.ts`; added a new `orgNavGroup` ("Agency") with Operations as the first org-level item, wired into `Sidebar.tsx` before project groups.
- **`pnpm install`:** Initial install failed on native `sharp` build; completed with `pnpm install --frozen-lockfile --ignore-scripts` (lockfile unchanged, no new packages).
- **Route tree:** Regenerated via `pnpm vite build` (not hand-edited).
