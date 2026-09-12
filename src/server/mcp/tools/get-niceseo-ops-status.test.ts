import { describe, expect, it, vi } from "vitest";
import {
  fetchAgencyPixelStatus,
  normalizeOpsDomain,
  pickPixelFromAgencyMetrics,
} from "./agency-metrics-pixel";
import { getNiceseoOpsStatusTool } from "./get-niceseo-ops-status";

vi.mock("@/server/features/agency/AgencyOttoProposalsService", () => ({
  listHomegrownOttoProposals: vi.fn(async () => []),
}));

describe("normalizeOpsDomain", () => {
  it("strips protocol www path and query", () => {
    expect(normalizeOpsDomain("https://www.niceseo.ai/path?x=1")).toBe(
      "niceseo.ai",
    );
  });
});

describe("pickPixelFromAgencyMetrics", () => {
  it("matches domain and reads pixel object", () => {
    const slice = pickPixelFromAgencyMetrics(
      {
        clients: [
          {
            domain: "twa.studio",
            niceseo_pixel_status: "live",
            pixel: {
              status: "live",
              events_7d: 12,
              as_of: "2026-08-30T00:00:00Z",
              served_fix_keys: ["title", "schema"],
              served_fix_paths: { "/": ["title", "schema"] },
            },
          },
          {
            domain: "niceseo.ai",
            niceseo_pixel_status: "none",
            pixel: {
              status: "none",
              events_7d: 0,
              as_of: "2026-08-30T00:00:00Z",
              served_fix_keys: ["title", "description", "h1"],
              served_fix_paths: {
                "/": ["title", "description"],
                "/blog": ["h1"],
              },
            },
          },
        ],
      },
      "https://www.niceseo.ai/",
    );
    expect(slice.found).toBe(true);
    expect(slice.status).toBe("none");
    expect(slice.events_7d).toBe(0);
    expect(slice.niceseo_pixel_status).toBe("none");
    expect(slice.served_fix_keys).toEqual(["title", "description", "h1"]);
    expect(slice.served_fix_paths).toEqual({
      "/": ["title", "description"],
      "/blog": ["h1"],
    });
  });

  it("falls back to flat served_fix fields and drops empty or non-string entries", () => {
    const slice = pickPixelFromAgencyMetrics(
      {
        clients: [
          {
            domain: "twa.studio",
            served_fix_keys: ["title", 42, "", "og_title"],
            served_fix_paths: {
              "/": ["title", "", 7],
              "": ["h1"],
              "/empty": [],
              "/bad": "nope",
            },
          },
        ],
      },
      "twa.studio",
    );
    expect(slice.found).toBe(true);
    expect(slice.served_fix_keys).toEqual(["title", "og_title"]);
    expect(slice.served_fix_paths).toEqual({ "/": ["title"] });
  });

  it("returns empty served_fix fields when the fields are absent", () => {
    const slice = pickPixelFromAgencyMetrics(
      { clients: [{ domain: "twa.studio", pixel: { status: "live" } }] },
      "twa.studio",
    );
    expect(slice.found).toBe(true);
    expect(slice.served_fix_keys).toEqual([]);
    expect(slice.served_fix_paths).toEqual({});
  });

  it("returns found false when domain missing", () => {
    const slice = pickPixelFromAgencyMetrics(
      { clients: [{ domain: "other.com", pixel: { status: "live" } }] },
      "niceseo.ai",
    );
    expect(slice.found).toBe(false);
  });
});

describe("fetchAgencyPixelStatus", () => {
  it("reports not configured without env", async () => {
    const result = await fetchAgencyPixelStatus("niceseo.ai", {
      metricsUrl: "",
      token: "",
    });
    expect(result.configured).toBe(false);
    expect(result.error).toMatch(/not configured/);
  });

  it("parses metrics JSON via fetchImpl", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            clients: [
              {
                domain: "niceseo.ai",
                pixel: {
                  status: "none",
                  events_7d: 0,
                  as_of: "2026-08-30",
                  served_fix_keys: ["title"],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await fetchAgencyPixelStatus("niceseo.ai", {
      metricsUrl: "https://webhook.niceseo.ai/api/v1/agency-metrics",
      token: "test-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.configured).toBe(true);
    expect(result.error).toBeNull();
    expect(result.pixel.found).toBe(true);
    expect(result.pixel.status).toBe("none");
    expect(result.pixel.served_fix_keys).toEqual(["title"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calls = fetchImpl.mock.calls as unknown as ReadonlyArray<
      ReadonlyArray<unknown>
    >;
    const calledUrl = String(calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("t=test-token");
  });
});

describe("getNiceseoOpsStatusTool handler", () => {
  async function runHandlerWithPixel(pixel: Record<string, unknown>) {
    const prevMetricsUrl = process.env.AGENCY_METRICS_URL;
    const prevDashToken = process.env.AGENCY_DASH_TOKEN;
    process.env.AGENCY_METRICS_URL =
      "https://webhook.niceseo.ai/api/v1/agency-metrics";
    process.env.AGENCY_DASH_TOKEN = "test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ clients: [{ domain: "twa.studio", pixel }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    try {
      return await getNiceseoOpsStatusTool.handler(
        { domain: "twa.studio" },
        {} as never,
      );
    } finally {
      if (prevMetricsUrl === undefined) {
        delete process.env.AGENCY_METRICS_URL;
      } else {
        process.env.AGENCY_METRICS_URL = prevMetricsUrl;
      }
      if (prevDashToken === undefined) {
        delete process.env.AGENCY_DASH_TOKEN;
      } else {
        process.env.AGENCY_DASH_TOKEN = prevDashToken;
      }
      vi.unstubAllGlobals();
    }
  }

  it("prints fixes with per-path detail and carries both fields in structuredContent", async () => {
    const result = await runHandlerWithPixel({
      status: "live",
      events_7d: 12,
      as_of: "2026-09-01T00:00:00Z",
      served_fix_keys: ["description", "h1", "title"],
      served_fix_paths: {
        "/": ["description", "title"],
        "/blog": ["h1"],
      },
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(
      "NiceSEO pixel: already applied by the pixel: description, h1, title",
    );
    expect(text).toContain(
      "NiceSEO pixel: already applied by the pixel per path: /: description, title; /blog: h1",
    );
    expect(result.structuredContent.pixel.served_fix_keys).toEqual([
      "description",
      "h1",
      "title",
    ]);
    expect(result.structuredContent.pixel.served_fix_paths).toEqual({
      "/": ["description", "title"],
      "/blog": ["h1"],
    });
  });

  it("qualifies the union line when per-path detail is unavailable", async () => {
    const result = await runHandlerWithPixel({
      status: "live",
      served_fix_keys: ["title", "description"],
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(
      "NiceSEO pixel: already applied by the pixel (per-path detail unavailable): title, description — treat as domain-wide hints, verify before re-proposing",
    );
    expect(text).not.toContain("per path:");
  });

  it("prints none reported when the pixel serves no fixes", async () => {
    const result = await runHandlerWithPixel({ status: "live", events_7d: 3 });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(
      "NiceSEO pixel: already applied by the pixel: none reported",
    );
  });
});
