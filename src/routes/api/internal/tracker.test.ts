import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";

const {
  mockEnv,
  getProjectForOrganization,
  getConfigs,
  createConfig,
  getTracker,
  addKeywords,
  triggerCheck,
  refreshKeywordMetrics,
  getLatestResults,
} = vi.hoisted(() => ({
  mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string; AUTH_MODE?: string },
  getProjectForOrganization: vi.fn(),
  getConfigs: vi.fn(),
  createConfig: vi.fn(),
  getTracker: vi.fn(),
  addKeywords: vi.fn(),
  triggerCheck: vi.fn(),
  refreshKeywordMetrics: vi.fn(),
  getLatestResults: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: (...args: unknown[]) =>
      getProjectForOrganization(...args),
  },
}));

vi.mock("@/server/features/rank-tracking/services/RankTrackingService", () => ({
  RankTrackingService: {
    getConfigs: (...args: unknown[]) => getConfigs(...args),
    createConfig: (...args: unknown[]) => createConfig(...args),
    getTracker: (...args: unknown[]) => getTracker(...args),
    addKeywords: (...args: unknown[]) => addKeywords(...args),
    triggerCheck: (...args: unknown[]) => triggerCheck(...args),
    refreshKeywordMetrics: (...args: unknown[]) => refreshKeywordMetrics(...args),
  },
}));

vi.mock("@/server/features/rank-tracking/services/rankTrackingResults", () => ({
  getLatestResults: (...args: unknown[]) => getLatestResults(...args),
}));

import { handleGet, handlePost } from "./tracker";

const TOKEN = "test-export-token";
const BASE = "http://localhost/api/internal/tracker";
const PROJECT_ID = "project_1";

const PROJECT = {
  id: PROJECT_ID,
  name: "Acme",
  domain: "example.com",
  locationCode: 2840,
  languageCode: "en",
  createdAt: "2026-01-01 00:00:00",
};

const CONFIG = {
  id: "config_1",
  projectId: PROJECT_ID,
  domain: "example.com",
  locationCode: 2840,
  languageCode: "en",
  locationName: null,
  devices: "both" as const,
  serpDepth: 40,
  scheduleInterval: "manual" as const,
  isActive: true,
};

function get(path = "", headers?: HeadersInit): Request {
  return new Request(`${BASE}${path}`, { headers });
}

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

const auth = { authorization: `Bearer ${TOKEN}` };

const seedBody = {
  projectId: PROJECT_ID,
  keywords: ["seo tools"],
  maxEstimatedScheduledCheckCredits: 12,
};

function expectTrackerServicesIdle() {
  expect(getConfigs).not.toHaveBeenCalled();
  expect(createConfig).not.toHaveBeenCalled();
  expect(getTracker).not.toHaveBeenCalled();
  expect(addKeywords).not.toHaveBeenCalled();
  expect(triggerCheck).not.toHaveBeenCalled();
  expect(refreshKeywordMetrics).not.toHaveBeenCalled();
  expect(getLatestResults).not.toHaveBeenCalled();
}

beforeEach(() => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  delete mockEnv.AUTH_MODE;
  getProjectForOrganization.mockImplementation(
    async (_organizationId: string, projectId: string) => {
      if (projectId === PROJECT_ID) return PROJECT;
      throw new AppError("NOT_FOUND");
    },
  );
  getConfigs.mockResolvedValue([CONFIG]);
  createConfig.mockResolvedValue({ ...CONFIG, id: "config_new" });
  getTracker.mockRejectedValue(new Error("getTracker must not be required"));
  addKeywords.mockResolvedValue({ added: 1, addedIds: ["kw_1"] });
  triggerCheck.mockImplementation(async () => {
    throw new Error("triggerCheck must not be called");
  });
  refreshKeywordMetrics.mockImplementation(async () => {
    throw new Error("refreshKeywordMetrics must not be called");
  });
  getLatestResults.mockResolvedValue({ rows: [], run: null });
});

describe("internal tracker auth", () => {
  it("returns 503 agency_score_export_disabled when token unset", async () => {
    delete mockEnv.AGENCY_SCORE_EXPORT_TOKEN;
    const res = await handleGet(get(`?projectId=${PROJECT_ID}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "agency_score_export_disabled",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(getProjectForOrganization).not.toHaveBeenCalled();
    expectTrackerServicesIdle();
  });

  it("returns 401 when bearer is wrong", async () => {
    const res = await handlePost(
      post(seedBody, { authorization: "Bearer wrong-token" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(getProjectForOrganization).not.toHaveBeenCalled();
    expectTrackerServicesIdle();
  });

  it("refuses both verbs with 403 under AUTH_MODE=hosted", async () => {
    mockEnv.AUTH_MODE = "hosted";

    const listed = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(listed.status).toBe(403);
    expect(await listed.json()).toEqual({ error: "unsupported_auth_mode" });

    const seeded = await handlePost(post(seedBody, auth));
    expect(seeded.status).toBe(403);
    expect(await seeded.json()).toEqual({ error: "unsupported_auth_mode" });
    expect(getProjectForOrganization).not.toHaveBeenCalled();
    expectTrackerServicesIdle();
  });

  it("scopes ownership to delegated-local-admin under AUTH_MODE=local_noauth", async () => {
    mockEnv.AUTH_MODE = "local_noauth";

    const res = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(res.status).toBe(200);
    expect(getProjectForOrganization).toHaveBeenCalledWith(
      "delegated-local-admin",
      PROJECT_ID,
    );
  });
});

describe("internal tracker ownership", () => {
  it("returns 404 when projectId is not in the resolved org", async () => {
    const listed = await handleGet(get("?projectId=other_project", auth));
    expect(listed.status).toBe(404);
    expect(await listed.json()).toEqual({ error: "project_not_found" });

    const seeded = await handlePost(
      post({ ...seedBody, projectId: "other_project" }, auth),
    );
    expect(seeded.status).toBe(404);
    expect(await seeded.json()).toEqual({ error: "project_not_found" });
    expectTrackerServicesIdle();
  });
});

describe("internal tracker handleGet", () => {
  it("auto-resolves the tracker when the project has exactly one config", async () => {
    const results = { rows: [{ keyword: "seo" }], run: null };
    getLatestResults.mockResolvedValue(results);

    const res = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      configs: [CONFIG],
      tracker: { config: CONFIG, results },
    });
    expect(getProjectForOrganization).toHaveBeenCalledWith(
      "shared-workspace",
      PROJECT_ID,
    );
    expect(getConfigs).toHaveBeenCalledWith(PROJECT_ID);
    expect(getLatestResults).toHaveBeenCalledWith("config_1", PROJECT_ID, "7d");
    expect(getTracker).not.toHaveBeenCalled();
  });

  it("returns 404 when an explicit configId is not in the list", async () => {
    const res = await handleGet(
      get(`?projectId=${PROJECT_ID}&configId=config_missing`, auth),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "config_not_found" });
    expect(getLatestResults).not.toHaveBeenCalled();
  });

  it("returns configs empty and tracker null when none exist", async () => {
    getConfigs.mockResolvedValue([]);

    const res = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configs: [], tracker: null });
    expect(getLatestResults).not.toHaveBeenCalled();
  });
});

describe("internal tracker handlePost", () => {
  it("seeds keywords with the caller's credit ceiling and does not start a check", async () => {
    const res = await handlePost(post(seedBody, auth));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      configId: "config_1",
      added: 1,
      addedIds: ["kw_1"],
    });
    expect(addKeywords).toHaveBeenCalledWith(
      "config_1",
      PROJECT_ID,
      ["seo tools"],
      {
        kind: "credit_ceiling",
        maxEstimatedScheduledCheckCredits: 12,
      },
    );
    expect(createConfig).not.toHaveBeenCalled();
    expect(triggerCheck).not.toHaveBeenCalled();
    expect(refreshKeywordMetrics).not.toHaveBeenCalled();
  });

  it("creates a manual config when the project has none", async () => {
    getConfigs.mockResolvedValue([]);
    createConfig.mockResolvedValue({ ...CONFIG, id: "config_new" });

    const res = await handlePost(post(seedBody, auth));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ configId: "config_new" });
    expect(createConfig).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      projectMarket: { locationCode: 2840, languageCode: "en" },
      domain: "example.com",
      locationCode: undefined,
      languageCode: undefined,
      locationName: undefined,
      serpDepth: 40,
      scheduleInterval: "manual",
    });
    expect(addKeywords).toHaveBeenCalledWith(
      "config_new",
      PROJECT_ID,
      ["seo tools"],
      {
        kind: "credit_ceiling",
        maxEstimatedScheduledCheckCredits: 12,
      },
    );
    expect(triggerCheck).not.toHaveBeenCalled();
    expect(refreshKeywordMetrics).not.toHaveBeenCalled();
  });

  it("refuses to seed an existing non-manual config", async () => {
    getConfigs.mockResolvedValue([
      { ...CONFIG, scheduleInterval: "weekly" as const },
    ]);

    const res = await handlePost(post(seedBody, auth));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "config_schedule_not_manual",
      detail: "weekly",
    });
    expect(addKeywords).not.toHaveBeenCalled();
    expect(createConfig).not.toHaveBeenCalled();
  });

  it("returns 409 when several configs exist", async () => {
    getConfigs.mockResolvedValue([
      { ...CONFIG, id: "config_a" },
      { ...CONFIG, id: "config_b" },
    ]);

    const res = await handlePost(post(seedBody, auth));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "multiple_configs",
      detail: ["config_a", "config_b"],
    });
    expect(createConfig).not.toHaveBeenCalled();
    expect(addKeywords).not.toHaveBeenCalled();
  });

  it("returns 400 validation_failed when the credit ceiling is breached", async () => {
    addKeywords.mockRejectedValue(
      new AppError("VALIDATION_ERROR", "Ceiling exceeded"),
    );

    const res = await handlePost(post(seedBody, auth));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "validation_failed",
      detail: "Ceiling exceeded",
    });
  });
});
