// Single source of truth for accepted ops artifact kinds. Neutral module with
// no server/db imports so shared zod schemas, the service, the repository, and
// client UI lists can all derive from it. The drizzle table stores kind as
// plain text, so adding a kind here plus the drizzle enum lists is type-level
// only — no migration needed.
export const KINDS = [
  "alert-cycle",
  "monthly-report",
  "monthly-export",
  "fix-changelog",
  "client-sync",
  "gbp-audit",
  "digest",
  "index-watchdog",
  "schema-proposals",
  "citations",
  "heatmap",
] as const;

export type Kind = (typeof KINDS)[number];
