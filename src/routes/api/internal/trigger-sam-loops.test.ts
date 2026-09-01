import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv, triggerSamLoopsForDomain } = vi.hoisted(() => ({
  mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string },
  triggerSamLoopsForDomain: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

vi.mock("@/server/features/sam-loops/services/SamLoopService", () => ({
  SamLoopService: {
    triggerSamLoopsForDomain: (...args: unknown[]) =>
      triggerSamLoopsForDomain(...args),
  },
}));

import { handlePost } from "./trigger-sam-loops";

const TOKEN = "test-export-token";
const BASE = "http://localhost/api/internal/trigger-sam-loops";

function post(
  body?: unknown,
  headers?: HeadersInit,
  rawBody?: string,
): Request {
  return new Request(BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
}

beforeEach(() => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  triggerSamLoopsForDomain.mockResolvedValue({
    ok: true,
    projectId: "project_niceseo",
    projectName: "Default",
    domain: "niceseo.ai",
    seeded: 0,
    results: [
      {
        loopId: "loop_1",
        loopName: "Site health",
        skillName: "site-health",
        result: { ok: true, runId: "run_1" },
      },
    ],
  });
});

describe("trigger-sam-loops handlePost", () => {
  it("returns 503 when the export token is unset", async () => {
    delete mockEnv.AGENCY_SCORE_EXPORT_TOKEN;
    const res = await handlePost(
      post({ domain: "niceseo.ai" }, { authorization: `Bearer ${TOKEN}` }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "agency_score_export_disabled",
    });
  });

  it("returns 401 when bearer is missing", async () => {
    const res = await handlePost(post({ domain: "niceseo.ai" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 when bearer is wrong", async () => {
    const res = await handlePost(
      post({ domain: "niceseo.ai" }, { authorization: "Bearer not-the-token" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(triggerSamLoopsForDomain).not.toHaveBeenCalled();
  });

  it("returns 400 when domain is missing", async () => {
    const res = await handlePost(
      post({}, { authorization: `Bearer ${TOKEN}` }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "domain_required" });
    expect(triggerSamLoopsForDomain).not.toHaveBeenCalled();
  });

  it("starts loops for the domain", async () => {
    const res = await handlePost(
      post(
        { domain: "niceseo.ai", names: ["site-health"] },
        { authorization: `Bearer ${TOKEN}` },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      projectId: "project_niceseo",
    });
    expect(triggerSamLoopsForDomain).toHaveBeenCalledWith({
      domain: "niceseo.ai",
      names: ["site-health"],
    });
  });

  it("returns 404 when the domain has no project", async () => {
    triggerSamLoopsForDomain.mockResolvedValue({
      ok: false,
      reason: "project_not_found",
    });
    const res = await handlePost(
      post({ domain: "niceseo.ai" }, { authorization: `Bearer ${TOKEN}` }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "project_not_found" });
  });

  it("returns 403 when the domain is not dogfood", async () => {
    triggerSamLoopsForDomain.mockResolvedValue({
      ok: false,
      reason: "domain_not_allowed",
    });
    const res = await handlePost(
      post({ domain: "twa.studio" }, { authorization: `Bearer ${TOKEN}` }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "domain_not_allowed" });
  });
});
