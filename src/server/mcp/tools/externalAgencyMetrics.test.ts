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
    expect(fetchImpl.mock.calls[0]![1].redirect).toBe("error");
    expect(fetchImpl.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
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
});
