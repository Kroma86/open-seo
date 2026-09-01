import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgencyScoreInputs } from "./AgencyScoreInputsService";

type GscRow = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

const mocks = vi.hoisted(() => ({
  projectRows: [] as Array<{
    id: string;
    name: string;
    domain: string;
    organizationId: string;
    archivedAt: string | null;
  }>,
  gsc: null as null | {
    siteUrl: string;
    createdAt: string;
    updatedAt: string;
  },
  ga4: null as null | {
    propertyId: string;
    propertyDisplayName: string;
    createdAt: string;
    updatedAt: string;
  },
  // Per-test GSC behavior: rows to return, or an error to throw.
  gscRows: [] as GscRow[],
  gscError: null as Error | null,
  getPerformance: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(mocks.projectRows),
      }),
    }),
  },
}));
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: {
    getByProjectId: vi.fn(async () => mocks.gsc),
  },
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: {
    getPerformance: mocks.getPerformance,
  },
}));
vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: {
    getByProjectId: vi.fn(async () => mocks.ga4),
  },
}));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigsForProject: vi.fn(async () => []),
    },
  }),
);
vi.mock(
  "@/server/features/dashboard/repositories/BacklinkSnapshotRepository",
  () => ({
    BacklinkSnapshotRepository: {
      getLatestForProject: vi.fn(async () => null),
    },
  }),
);
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    getLatestAuditForProject: vi.fn(async () => null),
  },
}));
vi.mock(
  "@/server/features/ai-visibility/services/aiVisibilityResults",
  () => ({
    getAgencyExportBlock: vi.fn(async () => null),
  }),
);

const PROJECT = {
  id: "p1",
  name: "niceseo.ai",
  domain: "niceseo.ai",
  organizationId: "org1",
  archivedAt: null,
};

const GSC_CONNECTION = {
  siteUrl: "sc-domain:niceseo.ai",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T12:00:00.000Z",
};

describe("getAgencyScoreInputs connections", () => {
  beforeEach(() => {
    mocks.projectRows = [];
    mocks.gsc = null;
    mocks.ga4 = null;
    mocks.gscRows = [];
    mocks.gscError = null;
    mocks.getPerformance.mockReset();
    mocks.getPerformance.mockImplementation(async () => {
      if (mocks.gscError) throw mocks.gscError;
      return {
        siteUrl: "sc-domain:niceseo.ai",
        connectedBy: null,
        request: { endDate: "2026-08-28" },
        rows: mocks.gscRows,
      };
    });
  });

  it("returns disconnected GSC/GA4 and native GBP gap when no project exists", async () => {
    const data = await getAgencyScoreInputs({ domain: "missing.example" });
    expect(data.projectId).toBeNull();
    expect(data.connections.gsc).toEqual({
      connected: false,
      siteUrl: null,
      connectedAt: null,
    });
    expect(data.connections.ga4.connected).toBe(false);
    expect(data.gsc).toBeNull();
    expect(data.gbp).toEqual({
      status: "not_connected_native",
      source: null,
      capturedAt: null,
    });
  });

  it("never calls GSC and reports gsc null when no property is mapped", async () => {
    mocks.projectRows = [PROJECT];
    const data = await getAgencyScoreInputs({ domain: "niceseo.ai" });
    expect(data.connections.gsc.connected).toBe(false);
    expect(data.gsc).toBeNull();
    expect(mocks.getPerformance).not.toHaveBeenCalled();
  });

  it("sums per-day rows into site totals with impression-weighted position", async () => {
    mocks.projectRows = [PROJECT];
    mocks.gsc = GSC_CONNECTION;
    mocks.gscRows = [
      { clicks: 100, impressions: 3000, ctr: 0.0333, position: 20 },
      { clicks: 20, impressions: 1000, ctr: 0.02, position: 12 },
    ];
    const data = await getAgencyScoreInputs({ domain: "https://www.niceseo.ai" });
    expect(data.connections.gsc).toEqual({
      connected: true,
      siteUrl: "sc-domain:niceseo.ai",
      connectedAt: "2026-08-30T00:00:00.000Z",
    });
    expect(data.gsc).toEqual({
      clicks: 120,
      impressions: 4000,
      ctr: 120 / 4000,
      position: (20 * 3000 + 12 * 1000) / 4000,
      capturedAt: "2026-08-28",
      source: "google_search_console",
    });
    expect(mocks.getPerformance).toHaveBeenCalledWith(
      expect.objectContaining({ dimensions: ["date"] }),
    );
  });

  it("returns gsc null (not zeros) when GSC responds with no rows", async () => {
    mocks.projectRows = [PROJECT];
    mocks.gsc = GSC_CONNECTION;
    mocks.gscRows = [];
    const data = await getAgencyScoreInputs({ domain: "niceseo.ai" });
    expect(data.connections.gsc.connected).toBe(true);
    expect(data.gsc).toBeNull();
  });

  it("returns gsc null (not zeros) when the GSC read throws", async () => {
    mocks.projectRows = [PROJECT];
    mocks.gsc = GSC_CONNECTION;
    mocks.gscError = new Error("expired grant");
    const data = await getAgencyScoreInputs({ domain: "niceseo.ai" });
    expect(data.connections.gsc.connected).toBe(true);
    expect(data.gsc).toBeNull();
  });

  it("returns aiVisibility null when never run", async () => {
    mocks.projectRows = [PROJECT];
    const data = await getAgencyScoreInputs({ domain: "niceseo.ai" });
    expect(data.aiVisibility).toBeNull();
  });

  it("keeps a real measured zero as zero", async () => {
    mocks.projectRows = [PROJECT];
    mocks.gsc = GSC_CONNECTION;
    // A day with genuine zero traffic is a measurement, not a gap.
    mocks.gscRows = [{ clicks: 0, impressions: 0, ctr: 0, position: 0 }];
    const data = await getAgencyScoreInputs({ domain: "niceseo.ai" });
    expect(data.gsc).toEqual({
      clicks: 0,
      impressions: 0,
      ctr: null,
      position: null,
      capturedAt: "2026-08-28",
      source: "google_search_console",
    });
  });
});
