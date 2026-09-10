import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import {
  getAgencyScoreInputs,
  getAgencyScoreInputsGlobal,
} from "./AgencyScoreInputsService";
import type { RankTrackingRow } from "@/types/schemas/rank-tracking";

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
  rankConfigs: [] as Array<{ id: string }>,
  latestResultsByConfig: new Map<
    string,
    {
      rows: RankTrackingRow[];
      run: {
        id: string;
        lastCheckedAt: string | null;
        status: "completed";
        errorMessage: null;
      } | null;
    }
  >(),
  // Per-test GSC behavior: rows to return, or an error to throw.
  gscRows: [] as GscRow[],
  gscError: null as Error | null,
  getPerformance: vi.fn(),
  getLatestResults: vi.fn(),
  resolveProjectByDomain: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
// The resolver's exact-domain / CONFLICT semantics are covered by
// ProjectRepository.query.test.ts; here it is a stand-in that records how the
// service calls it and returns the fixture rows.
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  normalizeProjectDomain: (raw: string | null | undefined) => {
    if (raw == null) return null;
    let host = raw.trim().toLowerCase();
    for (const prefix of ["https://", "http://"]) {
      if (host.startsWith(prefix)) host = host.slice(prefix.length);
    }
    if (host.startsWith("www.")) host = host.slice(4);
    host = host.split("/")[0] ?? host;
    return host || null;
  },
  ProjectRepository: {
    resolveProjectByDomain: (...args: unknown[]) =>
      mocks.resolveProjectByDomain(...args),
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
      getConfigsForProject: vi.fn(async () => mocks.rankConfigs),
    },
  }),
);
vi.mock("@/server/features/rank-tracking/services/rankTrackingResults", () => ({
  getLatestResults: (...args: unknown[]) => mocks.getLatestResults(...args),
}));
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
vi.mock("@/server/features/ai-visibility/services/aiVisibilityResults", () => ({
  getAgencyExportBlock: vi.fn(async () => null),
}));

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
    mocks.rankConfigs = [];
    mocks.latestResultsByConfig = new Map();
    mocks.gscRows = [];
    mocks.gscError = null;
    mocks.resolveProjectByDomain.mockReset();
    mocks.resolveProjectByDomain.mockImplementation(
      async () => mocks.projectRows[0] ?? null,
    );
    mocks.getPerformance.mockReset();
    mocks.getLatestResults.mockReset();
    mocks.getLatestResults.mockImplementation(
      async (configId: string) =>
        mocks.latestResultsByConfig.get(configId) ?? {
          rows: [],
          run: null,
        },
    );
    mocks.getPerformance.mockImplementation(async () => {
      if (mocks.gscError) throw mocks.gscError;
      return {
        siteUrl: "sc-domain:niceseo.ai",
        connectedBy: null,
        request: {
          startDate: "2026-08-01",
          endDate: "2026-08-28",
        },
        rows: mocks.gscRows,
      };
    });
  });

  it("returns disconnected GSC/GA4 and native GBP gap when no project exists", async () => {
    const data = await getAgencyScoreInputs({
      domain: "missing.example",
      organizationId: "org1",
    });
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

  it("resolves the project by exact domain inside the caller's organization", async () => {
    mocks.projectRows = [PROJECT];
    await getAgencyScoreInputs({
      domain: "https://www.niceseo.ai/",
      organizationId: "org1",
    });
    expect(mocks.resolveProjectByDomain).toHaveBeenCalledWith({
      domain: "niceseo.ai",
      organizationId: "org1",
    });
  });

  it("uses the unscoped resolver only for the global (Hermes) export", async () => {
    mocks.projectRows = [PROJECT];
    await getAgencyScoreInputsGlobal("niceseo.ai");
    expect(mocks.resolveProjectByDomain).toHaveBeenCalledWith({
      domain: "niceseo.ai",
      organizationId: null,
    });
  });

  it("returns empty inputs (not another project) when the domain resolves to nothing", async () => {
    mocks.projectRows = [];
    const data = await getAgencyScoreInputs({
      domain: "nobody.example",
      organizationId: "org1",
    });
    expect(data.projectId).toBeNull();
    expect(data.domain).toBe("nobody.example");
  });

  it("surfaces CONFLICT when two projects share the domain instead of picking one", async () => {
    mocks.resolveProjectByDomain.mockRejectedValue(
      new AppError(
        "CONFLICT",
        "ambiguous_project_domain: 2 projects share niceseo.ai",
      ),
    );
    await expect(
      getAgencyScoreInputs({ domain: "niceseo.ai", organizationId: "org1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("never calls GSC and reports gsc null when no property is mapped", async () => {
    mocks.projectRows = [PROJECT];
    const data = await getAgencyScoreInputs({
      domain: "niceseo.ai",
      organizationId: "org1",
    });
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
    const data = await getAgencyScoreInputs({
      domain: "https://www.niceseo.ai",
      organizationId: "org1",
    });
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
      windowStart: "2026-08-01",
      windowEnd: "2026-08-28",
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
    const data = await getAgencyScoreInputs({
      domain: "niceseo.ai",
      organizationId: "org1",
    });
    expect(data.connections.gsc.connected).toBe(true);
    expect(data.gsc).toBeNull();
  });

  it("returns gsc null (not zeros) when the GSC read throws", async () => {
    mocks.projectRows = [PROJECT];
    mocks.gsc = GSC_CONNECTION;
    mocks.gscError = new Error("expired grant");
    const data = await getAgencyScoreInputs({
      domain: "niceseo.ai",
      organizationId: "org1",
    });
    expect(data.connections.gsc.connected).toBe(true);
    expect(data.gsc).toBeNull();
  });

  it("returns aiVisibility null when never run", async () => {
    mocks.projectRows = [PROJECT];
    const data = await getAgencyScoreInputs({
      domain: "niceseo.ai",
      organizationId: "org1",
    });
    expect(data.aiVisibility).toBeNull();
  });

  it("keeps a real measured zero as zero", async () => {
    mocks.projectRows = [PROJECT];
    mocks.gsc = GSC_CONNECTION;
    // A day with genuine zero traffic is a measurement, not a gap.
    mocks.gscRows = [{ clicks: 0, impressions: 0, ctr: 0, position: 0 }];
    const data = await getAgencyScoreInputs({
      domain: "niceseo.ai",
      organizationId: "org1",
    });
    expect(data.gsc).toEqual({
      clicks: 0,
      impressions: 0,
      ctr: null,
      position: null,
      windowStart: "2026-08-01",
      windowEnd: "2026-08-28",
      capturedAt: "2026-08-28",
      source: "google_search_console",
    });
  });
});

function makeRankRow(
  keyword: string,
  desktop: number | null,
  mobile: number | null,
): RankTrackingRow {
  return {
    trackingKeywordId: `kw-${keyword}`,
    keyword,
    searchVolume: null,
    keywordDifficulty: null,
    cpc: null,
    desktop: {
      position: desktop,
      previousPosition: null,
      rankingUrl: desktop != null ? `https://example.com/${keyword}` : null,
      serpFeatures: [],
    },
    mobile: {
      position: mobile,
      previousPosition: null,
      rankingUrl: mobile != null ? `https://example.com/m/${keyword}` : null,
      serpFeatures: [],
    },
  };
}

describe("getAgencyScoreInputs rankSummary", () => {
  beforeEach(() => {
    mocks.projectRows = [PROJECT];
    mocks.gsc = null;
    mocks.ga4 = null;
    mocks.gscRows = [];
    mocks.gscError = null;
    mocks.resolveProjectByDomain.mockReset();
    mocks.resolveProjectByDomain.mockImplementation(
      async () => mocks.projectRows[0] ?? null,
    );
    mocks.getPerformance.mockReset();
    mocks.getLatestResults.mockReset();
    mocks.getLatestResults.mockImplementation(
      async (configId: string) =>
        mocks.latestResultsByConfig.get(configId) ?? {
          rows: [],
          run: null,
        },
    );
    mocks.rankConfigs = [
      { id: "cfg1" },
      { id: "cfg2" },
      { id: "cfg3" },
      { id: "cfg4" },
    ];
    mocks.latestResultsByConfig = new Map();
  });

  it("counts all active configs, not just the first three in ranks", async () => {
    mocks.latestResultsByConfig.set("cfg1", {
      rows: [makeRankRow("alpha", 5, null)],
      run: {
        id: "run1",
        lastCheckedAt: "2026-09-01T00:00:00.000Z",
        status: "completed",
        errorMessage: null,
      },
    });
    mocks.latestResultsByConfig.set("cfg2", {
      rows: [makeRankRow("beta", 8, null)],
      run: {
        id: "run2",
        lastCheckedAt: "2026-09-02T00:00:00.000Z",
        status: "completed",
        errorMessage: null,
      },
    });
    mocks.latestResultsByConfig.set("cfg3", {
      rows: [makeRankRow("gamma", 12, null)],
      run: {
        id: "run3",
        lastCheckedAt: "2026-09-03T00:00:00.000Z",
        status: "completed",
        errorMessage: null,
      },
    });
    mocks.latestResultsByConfig.set("cfg4", {
      rows: [makeRankRow("delta", 2, null)],
      run: {
        id: "run4",
        lastCheckedAt: "2026-09-04T00:00:00.000Z",
        status: "completed",
        errorMessage: null,
      },
    });

    const data = await getAgencyScoreInputs({
      domain: "niceseo.ai",
      organizationId: "org1",
    });

    expect(data.ranks?.keywords).toHaveLength(3);
    expect(data.ranks?.capturedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(data.rankSummary).toEqual({
      trackedKeywords: 4,
      top3: 1,
      top10: 3,
      capturedAt: "2026-09-04T00:00:00.000Z",
      source: "openseo_rank_tracker",
    });
  });

  it("dedupes keywords across devices using the best non-null position", async () => {
    mocks.rankConfigs = [{ id: "cfg1" }];
    mocks.latestResultsByConfig.set("cfg1", {
      rows: [makeRankRow("widget", 8, 2)],
      run: {
        id: "run1",
        lastCheckedAt: "2026-09-01T00:00:00.000Z",
        status: "completed",
        errorMessage: null,
      },
    });

    const data = await getAgencyScoreInputs({
      domain: "niceseo.ai",
      organizationId: "org1",
    });

    expect(data.rankSummary).toEqual({
      trackedKeywords: 1,
      top3: 1,
      top10: 1,
      capturedAt: "2026-09-01T00:00:00.000Z",
      source: "openseo_rank_tracker",
    });
  });

  it("pins ranks.capturedAt to the first three configs while rankSummary spans all", async () => {
    mocks.latestResultsByConfig.set("cfg1", {
      rows: [makeRankRow("alpha", 5, null)],
      run: {
        id: "run1",
        lastCheckedAt: "2026-09-01T00:00:00.000Z",
        status: "completed",
        errorMessage: null,
      },
    });
    mocks.latestResultsByConfig.set("cfg2", {
      rows: [makeRankRow("beta", 8, null)],
      run: {
        id: "run2",
        lastCheckedAt: "2026-09-02T00:00:00.000Z",
        status: "completed",
        errorMessage: null,
      },
    });
    mocks.latestResultsByConfig.set("cfg3", {
      rows: [makeRankRow("gamma", 12, null)],
      run: {
        id: "run3",
        lastCheckedAt: "2026-09-03T00:00:00.000Z",
        status: "completed",
        errorMessage: null,
      },
    });
    mocks.latestResultsByConfig.set("cfg4", {
      rows: [makeRankRow("delta", 2, null)],
      run: {
        id: "run4",
        lastCheckedAt: "2026-09-04T00:00:00.000Z",
        status: "completed",
        errorMessage: null,
      },
    });

    const data = await getAgencyScoreInputs({
      domain: "niceseo.ai",
      organizationId: "org1",
    });

    expect(data.ranks?.capturedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(data.rankSummary?.capturedAt).toBe("2026-09-04T00:00:00.000Z");
  });

  it("returns keyword count with null top buckets when configs exist but no snapshots yet", async () => {
    mocks.rankConfigs = [{ id: "cfg1" }];
    mocks.latestResultsByConfig.set("cfg1", {
      rows: [makeRankRow("alpha", null, null), makeRankRow("beta", null, null)],
      run: null,
    });

    const data = await getAgencyScoreInputs({
      domain: "niceseo.ai",
      organizationId: "org1",
    });

    expect(data.rankSummary).toEqual({
      trackedKeywords: 2,
      top3: null,
      top10: null,
      capturedAt: null,
      source: "openseo_rank_tracker",
    });
  });

  it("computes top buckets from positions even when lastCheckedAt is missing", async () => {
    mocks.rankConfigs = [{ id: "cfg1" }];
    mocks.latestResultsByConfig.set("cfg1", {
      rows: [makeRankRow("alpha", 2, null), makeRankRow("beta", 15, null)],
      run: null,
    });

    const data = await getAgencyScoreInputs({
      domain: "niceseo.ai",
      organizationId: "org1",
    });

    expect(data.rankSummary).toEqual({
      trackedKeywords: 2,
      top3: 1,
      top10: 1,
      capturedAt: null,
      source: "openseo_rank_tracker",
    });
    expect(mocks.getLatestResults).toHaveBeenCalledTimes(1);
  });

  it("returns keyword count with null top buckets when rows have URLs but no positions", async () => {
    mocks.rankConfigs = [{ id: "cfg1" }];
    mocks.latestResultsByConfig.set("cfg1", {
      rows: [
        {
          trackingKeywordId: "kw-alpha",
          keyword: "alpha",
          searchVolume: null,
          keywordDifficulty: null,
          cpc: null,
          desktop: {
            position: null,
            previousPosition: null,
            rankingUrl: "https://example.com/alpha",
            serpFeatures: [],
          },
          mobile: {
            position: null,
            previousPosition: null,
            rankingUrl: null,
            serpFeatures: [],
          },
        },
        {
          trackingKeywordId: "kw-beta",
          keyword: "beta",
          searchVolume: null,
          keywordDifficulty: null,
          cpc: null,
          desktop: {
            position: null,
            previousPosition: null,
            rankingUrl: null,
            serpFeatures: [],
          },
          mobile: {
            position: null,
            previousPosition: null,
            rankingUrl: "https://example.com/m/beta",
            serpFeatures: [],
          },
        },
      ],
      run: {
        id: "run1",
        lastCheckedAt: "2026-09-01T00:00:00.000Z",
        status: "completed",
        errorMessage: null,
      },
    });

    const data = await getAgencyScoreInputs({
      domain: "niceseo.ai",
      organizationId: "org1",
    });

    expect(data.rankSummary).toEqual({
      trackedKeywords: 2,
      top3: null,
      top10: null,
      capturedAt: "2026-09-01T00:00:00.000Z",
      source: "openseo_rank_tracker",
    });
  });

  it("returns rankSummary null when the project has no rank configs", async () => {
    mocks.rankConfigs = [];
    const data = await getAgencyScoreInputs({
      domain: "niceseo.ai",
      organizationId: "org1",
    });
    expect(data.rankSummary).toBeNull();
  });
});
