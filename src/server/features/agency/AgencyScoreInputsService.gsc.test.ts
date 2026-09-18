import { describe, expect, it, vi } from "vitest";
import { GscApiError, GscTokenError } from "@/server/lib/gscErrors";

// On 2026-09-18, 32 of the 34 clients with Search Console connected reported a
// bare null. The catch that produced it discarded the reason, so nobody could
// tell "this client has no impressions yet" from "the grant expired". These
// tests pin the reason to the result.

const getPerformance = vi.fn();

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance: (...a: unknown[]) => getPerformance(...a) },
}));
// loadGscTotals never touches the database; stubbing the client keeps the
// real drizzle module (and its `sql` export) intact for everything else.
vi.mock("@/db", () => ({ db: { select: () => ({}) } }));

const { loadGscTotals } = await import("./AgencyScoreInputsService");

const rows = (n: number) =>
  Array.from({ length: n }, () => ({ clicks: 3, impressions: 100, position: 8 }));

describe("loadGscTotals reports why it has no data", () => {
  it("returns totals and ok when rows come back", async () => {
    getPerformance.mockResolvedValueOnce({
      rows: rows(2),
      request: { startDate: "2026-08-18", endDate: "2026-09-15" },
    });
    const out = await loadGscTotals("p1", true);
    expect(out.status).toBe("ok");
    expect(out.totals?.clicks).toBe(6);
    expect(out.totals?.impressions).toBe(200);
    expect(out.error).toBeNull();
  });

  it("separates an empty property from an error", async () => {
    getPerformance.mockResolvedValueOnce({ rows: [], request: {} });
    const out = await loadGscTotals("p1", true);
    expect(out.totals).toBeNull();
    expect(out.status).toBe("no_rows");
  });

  it("names an expired or revoked grant", async () => {
    getPerformance.mockRejectedValueOnce(new GscTokenError("invalid_grant"));
    const out = await loadGscTotals("p1", true);
    expect(out.totals).toBeNull();
    expect(out.status).toBe("token_expired");
    expect(out.error).toContain("invalid_grant");
  });

  it("treats a 401 as an expired grant", async () => {
    getPerformance.mockRejectedValueOnce(new GscApiError(401, "Unauthorized"));
    expect((await loadGscTotals("p1", true)).status).toBe("token_expired");
  });

  // The actionable one: the account is connected but cannot read the property.
  it("names a permission problem separately from a generic failure", async () => {
    getPerformance.mockRejectedValueOnce(
      new GscApiError(403, "User does not have sufficient permission for site"),
    );
    const out = await loadGscTotals("p1", true);
    expect(out.status).toBe("permission_denied");
    expect(out.error).toContain("sufficient permission");
  });

  it("keeps the status code on any other API error", async () => {
    getPerformance.mockRejectedValueOnce(new GscApiError(500, "backend error"));
    const out = await loadGscTotals("p1", true);
    expect(out.status).toBe("api_error");
    expect(out.error).toContain("500");
  });

  it("reports not_connected without calling the API", async () => {
    getPerformance.mockClear();
    const out = await loadGscTotals("p1", false);
    expect(out.status).toBe("not_connected");
    expect(getPerformance).not.toHaveBeenCalled();
  });
});
