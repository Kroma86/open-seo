// Plain-English labels and filter grouping for ops artifact kinds.
// Kept in a .ts helper (not the .tsx page) so vitest can collect its tests.
export type OpsKindFilter =
  | "all"
  | "alert-cycle"
  | "monthly-report"
  | "digest"
  | "index-watchdog"
  | "schema-proposals"
  | "citations";

export const KIND_FILTERS: { id: OpsKindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "alert-cycle", label: "Alerts" },
  { id: "monthly-report", label: "Reports" },
  { id: "digest", label: "Digests" },
  { id: "index-watchdog", label: "Indexability checks" },
  { id: "schema-proposals", label: "Schema proposals" },
  { id: "citations", label: "Citation checks" },
];

const KIND_PILLS: Record<string, { label: string; tone: string }> = {
  "alert-cycle": { label: "alert", tone: "badge-error" },
  "monthly-report": { label: "report", tone: "badge-primary" },
  digest: { label: "digest", tone: "badge-ghost" },
  "index-watchdog": { label: "indexability", tone: "badge-ghost" },
  "schema-proposals": { label: "schema", tone: "badge-ghost" },
  citations: { label: "citations", tone: "badge-ghost" },
};

export function kindPillMeta(kind: string): { label: string; tone: string } {
  return KIND_PILLS[kind] ?? { label: kind, tone: "badge-ghost" };
}
