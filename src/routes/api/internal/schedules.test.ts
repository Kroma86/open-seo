import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEnv,
  getProjectForOrganization,
  getRankConfigs,
  updateRankConfig,
  getAiConfigs,
  updateAiConfig,
} = vi.hoisted(() => ({
  mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string; AUTH_MODE?: string },
  getProjectForOrganization: vi.fn(),
  getRankConfigs: vi.fn(),
  updateRankConfig: vi.fn(),
  getAiConfigs: vi.fn(),
  updateAiConfig: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { getProjectForOrganization },
}));

vi.mock("@/server/features/rank-tracking/services/RankTrackingService", () => ({
  RankTrackingService: {
    getConfigs: getRankConfigs,
    updateConfig: updateRankConfig,
  },
}));

vi.mock(
  "@/server/features/ai-visibility/repositories/AiVisibilityRepository",
  () => ({ AiVisibilityRepository: { getConfigsForProject: getAiConfigs } }),
);

vi.mock(
  "@/server/features/ai-visibility/services/AiVisibilityManagementService",
  () => ({ AiVisibilityManagementService: { updateConfig: updateAiConfig } }),
);

import { handleGet, handlePost } from "./schedules";

const TOKEN = "test-export-token";
const BASE = "http://localhost/api/internal/schedules";
const PROJECT_ID = "project_1";
const RANK_ID = "rank_1";
const AI_ID = "ai_1";
const auth = { authorization: `Bearer ${TOKEN}` };

function post(body: unknown, headers: HeadersInit = auth): Request {
  return new Request(BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
    body: JSON.stringify(body),
  });
}

const pause = (
  kind: string,
  configId: string,
  scheduleInterval = "manual",
  headers: HeadersInit = auth,
) => post({ projectId: PROJECT_ID, kind, configId, scheduleInterval }, headers);

beforeEach(() => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  delete mockEnv.AUTH_MODE;
  getProjectForOrganization.mockImplementation(
    async (_org: string, projectId: string) =>
      projectId === PROJECT_ID ? { id: projectId, domain: "acme.ca" } : null,
  );
  getRankConfigs.mockResolvedValue([
    { id: RANK_ID, scheduleInterval: "weekly", nextCheckAt: "2026-10-19" },
  ]);
  getAiConfigs.mockResolvedValue([
    { id: AI_ID, scheduleInterval: "monthly", nextRunAt: "2026-10-21" },
  ]);
});

describe("internal schedules", () => {
  it("refuses a missing token and a hosted deployment before reading anything", async () => {
    expect((await handleGet(new Request(`${BASE}?projectId=p`))).status).toBe(
      401,
    );
    expect(
      (await handlePost(pause("rank_tracker", RANK_ID, "manual", {}))).status,
    ).toBe(401);
    mockEnv.AUTH_MODE = "hosted";
    expect((await handlePost(pause("rank_tracker", RANK_ID))).status).toBe(403);
    expect(getProjectForOrganization).not.toHaveBeenCalled();
    expect(updateRankConfig).not.toHaveBeenCalled();
  });

  it("lists both kinds of schedule with their intervals", async () => {
    const res = await handleGet(
      new Request(`${BASE}?projectId=${PROJECT_ID}`, { headers: auth }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      domain: "acme.ca",
      rankTrackers: [
        {
          configId: RANK_ID,
          scheduleInterval: "weekly",
          nextCheckAt: "2026-10-19",
        },
      ],
      aiVisibility: [
        {
          configId: AI_ID,
          scheduleInterval: "monthly",
          nextRunAt: "2026-10-21",
        },
      ],
    });
  });

  it("pauses a rank tracker and an AI visibility config by setting them to manual", async () => {
    expect((await handlePost(pause("rank_tracker", RANK_ID))).status).toBe(200);
    expect(updateRankConfig).toHaveBeenCalledWith(RANK_ID, PROJECT_ID, {
      scheduleInterval: "manual",
    });
    expect((await handlePost(pause("ai_visibility", AI_ID))).status).toBe(200);
    expect(updateAiConfig).toHaveBeenCalledWith(AI_ID, PROJECT_ID, {
      scheduleInterval: "manual",
    });
  });

  it("restores a rank tracker to its old interval", async () => {
    await handlePost(pause("rank_tracker", RANK_ID, "daily"));
    expect(updateRankConfig).toHaveBeenCalledWith(RANK_ID, PROJECT_ID, {
      scheduleInterval: "daily",
    });
  });

  it("does not write for a config that is not on this project", async () => {
    const res = await handlePost(pause("rank_tracker", AI_ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "config_not_found" });
    expect(updateRankConfig).not.toHaveBeenCalled();
    expect(updateAiConfig).not.toHaveBeenCalled();
  });

  it("does not write 'daily' to an AI visibility config", async () => {
    const res = await handlePost(pause("ai_visibility", AI_ID, "daily"));
    expect(res.status).toBe(400);
    expect(updateAiConfig).not.toHaveBeenCalled();
  });

  it("does not write for an unknown project or a malformed body", async () => {
    const other = post({
      projectId: "nope",
      kind: "rank_tracker",
      configId: RANK_ID,
      scheduleInterval: "manual",
    });
    expect((await handlePost(other)).status).toBe(404);
    expect((await handlePost(post({ projectId: PROJECT_ID }))).status).toBe(
      400,
    );
    expect(updateRankConfig).not.toHaveBeenCalled();
  });
});
