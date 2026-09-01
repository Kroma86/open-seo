# P2b — Tracked AI Visibility (LLMV parity)

Built tracked AI visibility end-to-end, mirroring rank-tracking patterns against the frozen `ai_visibility_*` schema.

## What was built

### Backend feature (`src/server/features/ai-visibility/`)

- **`repositories/AiVisibilityRepository.ts`** — Config/prompt/run CRUD, due-config query, CAS schedule claims, `tryCreateRun` guarded by `ai_visibility_runs_one_inflight_idx`.
- **`services/AiVisibilityManagementService.ts`** — Config CRUD (one row per project+brand), prompt add/remove/toggle, `promptSetVersion` bump on any prompt-set change, 10 active-prompt cap.
- **`services/aiVisibilityRunGuards.ts`** — `beginAiVisibilityRun` / `failRunIfActive` (DB partial unique index = duplicate protection).
- **`services/runAiVisibilityCheck.ts`** — Synchronous run execution: one `getBrandLookup` + one `explorePrompt` per active prompt (platform-filtered), aggregates into run row, always completes or marks `failed`.
- **`services/aiVisibilityResults.ts`** — `getLatestResults(projectId)`, `getTrend(projectId)`, same-version deltas only, `measured: false` when never run, `getAgencyExportBlock` for agency score export.
- **`services/scheduledAiVisibilityChecks.ts`** — Cron entry: due configs only, no paid calls when nothing due / no prompts / free plan; reschedules weekly/monthly; restores slot on `already_running`.

### Shared / schemas

- **`src/shared/ai-visibility.ts`** — Schedule helpers, platform parsing, prompt cap constant.
- **`src/types/schemas/ai-visibility.ts`** — Zod schemas for server functions + result shapes.

### MCP / Sam tools

- **`src/server/mcp/tools/get-ai-visibility-trend.ts`** — Read-only, free, never triggers runs.
- **`src/server/mcp/tools/run-ai-visibility-check.ts`** — Explicit paid check with cost warning in description.
- **`src/server/mcp/tools/manage-ai-visibility-tracking.ts`** — Config + prompt CRUD.
- Registered in **`src/server/mcp/server.ts`** and **`src/server/features/sam/samChatTools.ts`**.

### Internal export

- **`src/server/features/agency/AgencyScoreInputsService.ts`** — Additive `aiVisibility` block (`source: "dataforseo_llm_mentions"`, `null` when never run). Route handler unchanged (returns service payload).

### UI

- **`src/routes/_project/p/$projectId/ai-visibility.tsx`**
- **`src/client/features/ai-visibility/AiVisibilityPage.tsx`** — Minimal tracked prompts, latest run summary, trend list, honest empty state.
- **`src/serverFunctions/ai-visibility.ts`**
- Nav link under **My Site** in **`src/client/navigation/items.ts`**.

### Cron wiring

- **`src/server.ts`** — `runScheduledAiVisibilityChecks` after rank checks, same `withPgClient` pattern.

## File list (new / modified)

**New**

- `src/shared/ai-visibility.ts`
- `src/types/schemas/ai-visibility.ts`
- `src/server/features/ai-visibility/repositories/AiVisibilityRepository.ts`
- `src/server/features/ai-visibility/repositories/AiVisibilityRepository.query.test.ts`
- `src/server/features/ai-visibility/services/AiVisibilityManagementService.ts`
- `src/server/features/ai-visibility/services/AiVisibilityManagementService.test.ts`
- `src/server/features/ai-visibility/services/aiVisibilityRunGuards.ts`
- `src/server/features/ai-visibility/services/aiVisibilityRunGuards.test.ts`
- `src/server/features/ai-visibility/services/runAiVisibilityCheck.ts`
- `src/server/features/ai-visibility/services/aiVisibilityResults.ts`
- `src/server/features/ai-visibility/services/aiVisibilityResults.test.ts`
- `src/server/features/ai-visibility/services/scheduledAiVisibilityChecks.ts`
- `src/server/features/ai-visibility/services/scheduledAiVisibilityChecks.test.ts`
- `src/server/mcp/tools/get-ai-visibility-trend.ts`
- `src/server/mcp/tools/run-ai-visibility-check.ts`
- `src/server/mcp/tools/manage-ai-visibility-tracking.ts`
- `src/server/mcp/tools/ai-visibility-tools.test.ts`
- `src/serverFunctions/ai-visibility.ts`
- `src/client/features/ai-visibility/AiVisibilityPage.tsx`
- `src/routes/_project/p/$projectId/ai-visibility.tsx`

**Modified**

- `src/server.ts`
- `src/server/mcp/server.ts`
- `src/server/features/sam/samChatTools.ts`
- `src/server/features/agency/AgencyScoreInputsService.ts`
- `src/server/features/agency/AgencyScoreInputsService.test.ts`
- `src/client/navigation/items.ts`

## Acceptance verification

| Check | Result |
|-------|--------|
| `npx vitest run` | **1262 passed** (157 files), including all pre-existing tests + 17 new ones |
| `npx tsc --noEmit` | Full-project check **OOMs** on this machine (~4GB heap ceiling despite `NODE_OPTIONS`). New/edited files have **no IDE/linter TS diagnostics**; vitest transforms compile them successfully. |
| Schema / migrations | **Not touched** |
| Commit | **Not made** (per instructions) |

### New test coverage

- Repository: due query, in-flight unique index, CAS claim
- Guards: second in-flight run rejected
- Management: version bump on prompt change, 10-prompt cap
- Results: same-version delta rule, not-measured shape
- Scheduled: nothing-due → zero engine calls; no-prompts → zero engine calls
- Tools: trend never calls run path
- Export: `aiVisibility: null` when never run

## Ambiguities resolved

1. **Project-level vs config-level reads** — `getLatestResults` / `getTrend` take `projectId` with optional `configId`; default first active config (typical one brand per project).
2. **Prompt explorer models vs config platforms** — `google` is brand-lookup only; prompt explorer uses up to 2 models from `{chat_gpt, claude, gemini, perplexity}` intersected with config platforms.
3. **Synchronous runs vs rank workflows** — AI visibility runs inline (no Cloudflare Workflow); duplicate protection remains the DB partial unique index.
4. **`costNote`** — Built from per-call cache heuristic (fresh `fetchedAt` ≈ paid; otherwise cache hit), matching underlying R2 cache behavior without modifying ai-search services.
5. **Agency export shape** — Additive `aiVisibility` sibling to existing blocks; `null` when no completed run (never zero-filled).

## Repair round

Addressed reviewer findings without schema/migration, env, or dependency changes.

| Finding | Fix |
|---------|-----|
| **HIGH — crashed runs stick forever** | Added `aiVisibilityStaleRun.ts` + `aiVisibilityReconciler.ts` mirroring audit watchdog shape: `reclaimStaleRunsForConfig` runs before `beginAiVisibilityRun`; `reconcileStaleAiVisibilityRuns` runs in cron (`server.ts`) and at scheduled-check entry. In-flight rows older than 15 minutes (by `startedAt`, or `createdAt` when pending) are marked `failed` with `"stale run reclaimed"`. Repository integration tests: stale row no longer blocks; recent row still blocks. |
| **HIGH — fabricated zeros** | `runAiVisibilityCheck` counts `promptsChecked` from successful explorer results only; `promptsWithBrand` is `null` when no prompt produced a boolean answer. Google-only configs skip `explorePrompt` entirely. UI/MCP use `not measured` for nulls. Tests for google-only and all-errors paths. |
| **MEDIUM — costNote heuristics** | Brand lookup uses reliable cache signal (preserved `fetchedAt` on cache hit vs fresh on paid). Prompt explorer has no reliable signal — labeled `cache/paid uncertain`. Same honest rule: direct signal when available, otherwise uncertain (no latency guessing for prompts). |
| **MEDIUM — partial mention totals** | `sumMentionsForPlatforms` in `shared/ai-visibility-mentions.ts` returns `{ total, partialMentions }`; stored in run `detail.brandLookup.partialMentions`. UI/MCP render `≥ N (partial)` via `formatMentionsDisplay`; agency export includes `partialMentions`. |
| **MEDIUM — 10-prompt cap race** | `addPromptRespectingCap` / `activatePromptRespectingCap` use `runBatch` (insert → count → rollback delete when over cap). Repository test: 10th add succeeds, 11th fails, parallel race never exceeds 10 active. |
| **LOW — trend fetchedAt + source** | Trend points include `fetchedAt` (run `finishedAt`) and `source`; trend list UI shows the same `timestamp · dataforseo_llm_mentions` line as the Metric component. |

### Acceptance (repair round)

| Check | Result |
|-------|--------|
| `npx vitest run` | **1275 passed** (160 files) |
| `node --max-old-space-size=12288 node_modules/typescript/bin/tsc --noEmit` | **Clean** |
| Schema / migrations | **Not touched** |
| Commit | **Not made** (per instructions) |

## Repair round 2

Addressed final reviewer findings without schema/migration, env, or dependency changes.

| Finding | Fix |
|---------|-----|
| **HIGH — watchdog can reclaim a live run → double paid runs** | `AiVisibilityRepository.updateRunIfInFlight` compare-and-swap on terminal updates (`requireRunning: true` for completion, pending/running for failure). `runAiVisibilityCheck` skips `lastRunAt` when CAS returns 0 rows; reconciler `failStaleRun` uses the same guard. Stale threshold raised to **60 minutes**. Each `explorePrompt` call wrapped in try/catch so one prompt failure cannot abort the run; comment documents worst-case runtime vs threshold. |
| **HIGH — 10-active-prompt cap race** | Post-commit self-repair: insert/activate, then re-read active prompts ordered by `(createdAt, id)`; losers delete/deactivate their own row. Repository test races two adds at 9 active and asserts exactly one survives with cap error on the loser. |
| **MEDIUM — D1 stale-cutoff format mismatch** | Reconciler cutoff built with `new Date(Date.now() - THRESHOLD).toISOString()` for all providers (removed space-separated D1 format). Repository test reclaims a same-day stale run via ISO cutoff. |
| **MEDIUM — failed scheduled run silently eats the whole interval** | On thrown scheduled run (not `already_running`), `nextRunAt` set to now + 1 hour with backoff comment; test asserts `+1h` and failed run path. |
| **LOW — mixed denominator** | `promptsChecked` counts only prompts with a definitive `brandMentioned` answer; `detail.promptsAttempted` keeps the attempted count. |
| **LOW — brand cost label guess** | Fresh `fetchedAt` heuristic labels brand lookup `cache/paid uncertain` (never `paid` from latency). Preserved old `fetchedAt` still labeled cache hit. `getBrandLookup` exposes no cache/paid flag — freshness heuristic only. |

### Acceptance (repair round 2)

| Check | Result |
|-------|--------|
| `npx vitest run` | **1281 passed** (160 files) |
| `node --max-old-space-size=12288 node_modules/typescript/bin/tsc --noEmit` | **Clean** |
| Schema / migrations | **Not touched** |
| Commit | **Not made** (per instructions) |
