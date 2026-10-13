import { describe, expect, it, vi } from "vitest";
import { getAgencyScoreInputs } from "@/server/features/agency/AgencyScoreInputsService";
import type { AgencyScoreInputs } from "@/server/features/agency/AgencyScoreInputsService";
import { getAgencyScoreInputsTool } from "./get-agency-score-inputs";
import { makeToolContext, validateAsClientWould } from "./tool-test-support";

// The service module reaches "cloudflare:workers" through its repositories,
// which only exists in the Workers runtime. The handler is exercised against a
// fixed service result; the real service is covered by its own tests.
vi.mock("@/server/features/agency/AgencyScoreInputsService", () => ({
  getAgencyScoreInputs: vi.fn(),
}));

/**
 * The service grew accountEmail, gscStatus, gscTopQueries, rankSummary and
 * aiVisibility without the tool's outputSchema following, so every call failed
 * with "data must NOT have additional properties" (MCP -32602) and the weekly
 * client scores had no inputs. Every key of AgencyScoreInputs is populated here;
 * the annotation makes a new service field a type error until it is added.
 */
const inputs: AgencyScoreInputs = {
  domain: "example.com",
  projectId: "proj_1",
  projectName: "Example",
  connections: {
    gsc: {
      connected: true,
      siteUrl: "sc-domain:example.com",
      connectedAt: "2026-09-01T00:00:00.000Z",
      accountEmail: "owner@example.com",
      accountId: "acct_1",
    },
    ga4: {
      connected: true,
      propertyId: "123",
      propertyDisplayName: "Example GA4",
      connectedAt: "2026-09-01T00:00:00.000Z",
    },
  },
  gsc: {
    clicks: 10,
    impressions: 100,
    ctr: 0.1,
    position: 8.2,
    windowStart: "2026-09-15",
    windowEnd: "2026-10-12",
    capturedAt: "2026-10-12",
    source: "google_search_console",
  },
  gscStatus: "ok",
  gscError: null,
  gscTopQueries: [
    { query: "example", clicks: 5, impressions: 50, position: 3 },
  ],
  gbp: { status: "not_connected_native", source: null, capturedAt: null },
  ranks: {
    capturedAt: "2026-10-05 03:45:46",
    keywords: [
      { keyword: "example", position: 4, device: "mobile", url: null },
    ],
    source: "openseo_rank_tracker",
  },
  rankSummary: {
    trackedKeywords: 3,
    top3: 1,
    top10: 2,
    capturedAt: "2026-10-05 03:45:46",
    source: "openseo_rank_tracker",
  },
  backlinks: {
    capturedAt: "2026-10-01",
    referringDomains: 12,
    backlinks: 40,
    rank: 20,
    source: "openseo_backlink_snapshot",
  },
  audit: {
    capturedAt: "2026-10-02",
    status: "completed",
    pagesCrawled: 30,
    issueCount: 4,
    lighthouseSeoAvg: 92,
    source: "openseo_audit",
  },
  aiVisibility: {
    capturedAt: "2026-10-10",
    totalMentions: 6,
    partialMentions: false,
    shareOfVoicePct: 12.5,
    promptsWithBrand: 3,
    promptsChecked: 10,
    promptSetVersion: 2,
    source: "dataforseo_llm_mentions",
  },
};

async function callTool() {
  vi.mocked(getAgencyScoreInputs).mockResolvedValue(inputs);
  return getAgencyScoreInputsTool.handler(
    { domain: "example.com" },
    makeToolContext(),
  );
}

describe("get_agency_score_inputs output schema", () => {
  it("accepts everything the service returns", async () => {
    const result = await callTool();
    expect(
      validateAsClientWould(
        getAgencyScoreInputsTool.config.outputSchema,
        result.structuredContent,
      ),
    ).toMatchObject({ valid: true });
  });

  it("rejects a field the schema does not declare (not vacuous)", async () => {
    const result = await callTool();
    expect(
      validateAsClientWould(getAgencyScoreInputsTool.config.outputSchema, {
        ...result.structuredContent,
        undeclaredKey: "boom",
      }),
    ).toMatchObject({ valid: false });
  });
});
