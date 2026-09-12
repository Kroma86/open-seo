import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv, getAgencyLoopReports } = vi.hoisted(() => ({
  mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string },
  getAgencyLoopReports: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

vi.mock("@/server/features/agency/AgencyLoopReportsService", () => ({
  getAgencyLoopReports: (...args: unknown[]) => getAgencyLoopReports(...args),
}));

import { handleGet } from "./agency-loop-reports";

const TOKEN = "test-export-token";
const BASE = "http://localhost/api/internal/agency-loop-reports";

function request(path: string, headers?: HeadersInit): Request {
  return new Request(`${BASE}${path}`, { headers });
}

beforeEach(() => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  getAgencyLoopReports.mockResolvedValue({ runs: [], count: 0 });
});

describe("agency-loop-reports handleGet", () => {
  it("returns 503 agency_score_export_disabled when token unset", async () => {
    delete mockEnv.AGENCY_SCORE_EXPORT_TOKEN;
    const res = await handleGet(request("?since=2026-08-31T00:00:00.000Z"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "agency_score_export_disabled",
    });
  });

  it("returns 503 agency_score_export_disabled when token empty", async () => {
    mockEnv.AGENCY_SCORE_EXPORT_TOKEN = "   ";
    const res = await handleGet(request("?since=2026-08-31T00:00:00.000Z"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "agency_score_export_disabled",
    });
  });

  it("returns 401 when bearer is missing", async () => {
    const res = await handleGet(request("?since=2026-08-31T00:00:00.000Z"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 when bearer is wrong", async () => {
    const res = await handleGet(
      request("?since=2026-08-31T00:00:00.000Z", {
        authorization: "Bearer wrong-token",
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 on malformed authorization header", async () => {
    const res = await handleGet(
      request("?since=2026-08-31T00:00:00.000Z", {
        authorization: "Token not-a-bearer",
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 400 since_required without since", async () => {
    const res = await handleGet(
      request("", { authorization: `Bearer ${TOKEN}` }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "since_required" });
  });

  it("returns 400 invalid_since for malformed since", async () => {
    const res = await handleGet(
      request("?since=not-a-timestamp", {
        authorization: `Bearer ${TOKEN}`,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_since",
      hint: "ISO 8601 UTC, e.g. 2026-08-31T00:00:00.000Z",
    });
  });

  it("accepts millisecond UTC ISO since and returns service data", async () => {
    const payload = {
      runs: [{ id: "run_1" }],
      count: 1,
    };
    getAgencyLoopReports.mockResolvedValue(payload);

    const since = "2026-08-31T00:00:00.000Z";
    const res = await handleGet(
      request(`?since=${encodeURIComponent(since)}`, {
        authorization: `Bearer ${TOKEN}`,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(payload);
    expect(getAgencyLoopReports).toHaveBeenCalledWith(since, 50);
  });

  it("returns 400 invalid_limit on non-numeric limit", async () => {
    const res = await handleGet(
      request("?since=2026-08-31T00:00:00.000Z&limit=abc", {
        authorization: `Bearer ${TOKEN}`,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_limit" });
  });
});
