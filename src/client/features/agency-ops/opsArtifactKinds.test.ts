import { describe, expect, it } from "vitest";
import { KIND_FILTERS, kindPillMeta } from "./opsArtifactKinds";

describe("opsArtifactKinds", () => {
  it("labels the new kinds with plain-English group names", () => {
    const labels = new Map(KIND_FILTERS.map((f) => [f.id, f.label]));
    expect(labels.get("index-watchdog")).toBe("Indexability checks");
    expect(labels.get("schema-proposals")).toBe("Schema proposals");
    expect(labels.get("citations")).toBe("Citation checks");
    expect(labels.get("heatmap")).toBe("Heatmaps");
    expect(labels.get("monthly-export")).toBe("Monthly exports");
    expect(labels.get("fix-changelog")).toBe("Fix change logs");
    expect(labels.get("client-sync")).toBe("Client list checks");
    expect(labels.get("gbp-audit")).toBe("GBP audits");
  });

  it("keeps the existing kind labels unchanged", () => {
    const labels = new Map(KIND_FILTERS.map((f) => [f.id, f.label]));
    expect(labels.get("all")).toBe("All");
    expect(labels.get("alert-cycle")).toBe("Alerts");
    expect(labels.get("monthly-report")).toBe("Reports");
    expect(labels.get("digest")).toBe("Digests");
  });

  it("has a pill for every filter kind except 'all'", () => {
    for (const filter of KIND_FILTERS) {
      if (filter.id === "all") continue;
      const pill = kindPillMeta(filter.id);
      expect(pill.label).toBeTruthy();
      expect(pill.tone).toMatch(/^badge-/);
    }
  });

  it("exposes index-watchdog, schema-proposals, citations, and heatmap in filters and pills", () => {
    const labels = new Map(KIND_FILTERS.map((f) => [f.id, f.label]));
    expect(labels.get("index-watchdog")).toBe("Indexability checks");
    expect(labels.get("schema-proposals")).toBe("Schema proposals");
    expect(labels.get("citations")).toBe("Citation checks");
    expect(labels.get("heatmap")).toBe("Heatmaps");
    expect(kindPillMeta("index-watchdog")).toEqual({
      label: "indexability",
      tone: "badge-ghost",
    });
    expect(kindPillMeta("schema-proposals")).toEqual({
      label: "schema",
      tone: "badge-ghost",
    });
    expect(kindPillMeta("citations")).toEqual({
      label: "citations",
      tone: "badge-ghost",
    });
    expect(kindPillMeta("heatmap")).toEqual({
      label: "heatmap",
      tone: "badge-ghost",
    });
  });

  it("exposes monthly-export in filters and pills", () => {
    expect(KIND_FILTERS.some((f) => f.id === "monthly-export")).toBe(true);
    expect(kindPillMeta("monthly-export")).toEqual({
      label: "export",
      tone: "badge-primary",
    });
  });

  it("exposes fix-changelog, client-sync, and gbp-audit in filters and pills", () => {
    expect(kindPillMeta("fix-changelog")).toEqual({
      label: "changelog",
      tone: "badge-ghost",
    });
    expect(kindPillMeta("client-sync")).toEqual({
      label: "client-sync",
      tone: "badge-ghost",
    });
    expect(kindPillMeta("gbp-audit")).toEqual({
      label: "gbp-audit",
      tone: "badge-ghost",
    });
  });

  it("falls back to the raw kind for unknown values", () => {
    expect(kindPillMeta("something-else")).toEqual({
      label: "something-else",
      tone: "badge-ghost",
    });
  });
});
