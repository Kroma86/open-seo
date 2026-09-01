// Plain-English labels and filter grouping for ops artifact kinds.
// Kept in a .ts helper (not the .tsx page) so vitest can collect its tests.
// Filter/pill KEYS derive from the shared KINDS list so a kind cannot exist
// in the API without appearing in the UI lists.
import { KINDS, type Kind } from "@/shared/agency-ops";

export type OpsKindFilter = "all" | Kind;

const FILTER_LABELS: Record<Kind, string> = {
  "alert-cycle": "Alerts",
  "monthly-report": "Reports",
  digest: "Digests",
  "index-watchdog": "Indexability checks",
  "schema-proposals": "Schema proposals",
  citations: "Citation checks",
  heatmap: "Heatmaps",
};

export const KIND_FILTERS: { id: OpsKindFilter; label: string }[] = [
  { id: "all", label: "All" },
  ...KINDS.map((id) => ({ id, label: FILTER_LABELS[id] })),
];

const KIND_PILLS: Record<Kind, { label: string; tone: string }> = {
  "alert-cycle": { label: "alert", tone: "badge-error" },
  "monthly-report": { label: "report", tone: "badge-primary" },
  digest: { label: "digest", tone: "badge-ghost" },
  "index-watchdog": { label: "indexability", tone: "badge-ghost" },
  "schema-proposals": { label: "schema", tone: "badge-ghost" },
  citations: { label: "citations", tone: "badge-ghost" },
  heatmap: { label: "heatmap", tone: "badge-ghost" },
};

export function kindPillMeta(kind: string): { label: string; tone: string } {
  return KIND_PILLS[kind as Kind] ?? { label: kind, tone: "badge-ghost" };
}
