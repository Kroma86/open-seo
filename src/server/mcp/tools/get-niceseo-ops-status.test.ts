import { describe, expect, it, vi } from "vitest";
import {
  fetchAgencyPixelStatus,
  normalizeOpsDomain,
  pickPixelFromAgencyMetrics,
} from "./agency-metrics-pixel";

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
            pixel: { status: "live", events_7d: 12, as_of: "2026-08-30T00:00:00Z" },
          },
          {
            domain: "niceseo.ai",
            niceseo_pixel_status: "none",
            pixel: { status: "none", events_7d: 0, as_of: "2026-08-30T00:00:00Z" },
          },
        ],
      },
      "https://www.niceseo.ai/",
    );
    expect(slice.found).toBe(true);
    expect(slice.status).toBe("none");
    expect(slice.events_7d).toBe(0);
    expect(slice.niceseo_pixel_status).toBe("none");
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
                pixel: { status: "none", events_7d: 0, as_of: "2026-08-30" },
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
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calls = fetchImpl.mock.calls as unknown as ReadonlyArray<
      ReadonlyArray<unknown>
    >;
    const calledUrl = String(calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("t=test-token");
  });
});
