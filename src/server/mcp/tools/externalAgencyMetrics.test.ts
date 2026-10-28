import { describe, expect, it, vi } from "vitest";
import { fetchExternalAgencyMetrics } from "./externalAgencyMetrics";
vi.mock("@/server/lib/runtime-env", () => ({ getOptionalEnvValue: async () => undefined }));
const config = { metricsUrl: "https://metrics.example.com/api", token: "synthetic" };

describe("project-scoped stored observation feed", () => {
  it("selects only one exact authorized domain with www normalization", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ clients: [
      { domain: "other.example.com", external_ai_visibility: { secret: "other" } },
      { domain: "www.EXAMPLE.com", external_ai_visibility: { source: "expected" }, external_rank_observations: { observations: [] } },
    ] })));
    const result = await fetchExternalAgencyMetrics("example.com", { ...config, fetchImpl });
    expect(result.ai).toEqual({ source: "expected" });
    expect(result.error).toBeNull();
    expect(fetchImpl.mock.calls[0]![1].redirect).toBe("manual");
    expect(fetchImpl.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.searchParams.has("t")).toBe(false);
    expect(fetchImpl.mock.calls[0]![1].headers.Authorization).toBe("Bearer synthetic");
  });
  it("strips t/token from a configured URL and keeps the token out of it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ clients: [{ domain: "example.com" }] })));
    await fetchExternalAgencyMetrics("example.com", { ...config, metricsUrl: "https://metrics.example.com/api?t=stale&token=stale", fetchImpl });
    const called = String(fetchImpl.mock.calls[0]![0]);
    const url = new URL(called);
    expect(url.searchParams.has("t")).toBe(false);
    expect(url.searchParams.has("token")).toBe(false);
    expect(called).not.toContain("synthetic");
  });
  it.each([null, "", "https://example.com", "user@example.com", "example.com/path"])("does not fetch for invalid project domain: %s", async (domain) => {
    const fetchImpl = vi.fn();
    const result = await fetchExternalAgencyMetrics(domain, { ...config, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ai).toBeNull();
    expect(result.error).toBeTruthy();
  });
  it.each([
    { clients: [] }, { clients: [{ domain: "other.example.com" }] },
    { clients: [{ domain: "example.com" }, { domain: "www.example.com" }] }, {}, null,
  ])("rejects missing, ambiguous and malformed row selection", async (payload) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)));
    const result = await fetchExternalAgencyMetrics("example.com", { ...config, fetchImpl });
    expect(result.rank).toBeNull(); expect(result.ai).toBeNull(); expect(result.error).toBeTruthy();
  });
  it("does not expose endpoint/token details after timeout", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("https://metrics.example.com?t=synthetic"));
    const result = await fetchExternalAgencyMetrics("example.com", { ...config, fetchImpl });
    expect(result.error).toContain("timed out"); expect(result.error).not.toContain("synthetic");
  });
  it("preserves missing fields without manufacturing evidence", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ clients: [{ domain: "example.com" }] })));
    expect(await fetchExternalAgencyMetrics("example.com", { ...config, fetchImpl })).toEqual({ rank: null, ai: null, error: null });
  });
  it("requires configuration and successful status", async () => {
    expect((await fetchExternalAgencyMetrics("example.com")).error).toContain("not configured");
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    expect((await fetchExternalAgencyMetrics("example.com", { ...config, fetchImpl })).error).toContain("request failed");
  });
  it("rejects oversized feeds even when content-length is absent or understated", async () => {
    for (const headers of [new Headers(), new Headers({ "content-length": "1" })]) {
      const cancel = vi.fn();
      const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel });
      const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { headers }));
      const result = await fetchExternalAgencyMetrics("example.com", { ...config, fetchImpl });
      expect(result.ai).toBeNull();
      expect(result.error).toBeTruthy();
      expect(cancel).toHaveBeenCalled();
    }
  });
  it("accepts redirect manual on a workerd-like fetch and returns the stored feed", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.redirect !== "follow" && init?.redirect !== "manual") throw new TypeError("Invalid redirect value, must be follow or manual");
      return new Response(JSON.stringify({ clients: [{ domain: "example.com", external_ai_visibility: { source: "stored" }, external_rank_observations: { observations: [] } }] }));
    });
    await expect(fetchImpl(config.metricsUrl, { redirect: "error" })).rejects.toThrow(/Invalid redirect value/);
    expect(await fetchExternalAgencyMetrics("example.com", { ...config, fetchImpl })).toEqual({ rank: { observations: [] }, ai: { source: "stored" }, error: null });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![1]!.redirect).toBe("manual");
  });
  it.each([301, 302, 303, 307, 308])("returns a generic failure for redirect %s without following Location", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ clients: [{ domain: "example.com", external_ai_visibility: { source: "stored" }, external_rank_observations: { observations: [1] } }] }), { status, headers: { Location: "https://evil.example/collect?token=synthetic" } }));
    const result = await fetchExternalAgencyMetrics("example.com", { ...config, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ rank: null, ai: null, error: "External observations unavailable: agency feed request failed." });
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(JSON.stringify(result)).not.toContain("evil.example");
  });
});
