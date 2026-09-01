import { describe, expect, it } from "vitest";
import { KIND_FILTERS, kindPillMeta } from "./opsArtifactKinds";

describe("opsArtifactKinds", () => {
  it("labels the new kinds with plain-English group names", () => {
    const labels = new Map(KIND_FILTERS.map((f) => [f.id, f.label]));
    expect(labels.get("index-watchdog")).toBe("Indexability checks");
    expect(labels.get("schema-proposals")).toBe("Schema proposals");
    expect(labels.get("citations")).toBe("Citation checks");
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

  it("falls back to the raw kind for unknown values", () => {
    expect(kindPillMeta("something-else")).toEqual({
      label: "something-else",
      tone: "badge-ghost",
    });
  });
});
