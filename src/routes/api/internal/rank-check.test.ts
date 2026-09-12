import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";

const {
  mockEnv,
  listMembers,
  listUsers,
  getProjectForOrganization,
  triggerCheck,
} = vi.hoisted(() => {
  const listMembers = vi.fn();
  const listUsers = vi.fn();
  return {
    mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string; AUTH_MODE?: string },
    listMembers,
    listUsers,
    getProjectForOrganization: vi.fn(),
    triggerCheck: vi.fn(),
  };
});

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

vi.mock("@/db", async () => {
  const { user } = await import("@/db/schema");
  const chain: {
    from: (table?: unknown) => unknown;
    innerJoin: () => unknown;
    where: () => unknown;
    orderBy: () => unknown;
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise<unknown>;
    _from: unknown;
  } = {
    _from: null,
    from: (table?: unknown) => {
      chain._from = table;
      return chain;
    },
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve(chain._from === user ? listUsers() : listMembers()).then(
        onFulfilled,
        onRejected,
      ),
  };
  return { db: { select: () => chain } };
});

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: (...args: unknown[]) =>
      getProjectForOrganization(...args),
  },
}));

vi.mock("@/server/features/rank-tracking/services/RankTrackingService", () => ({
  RankTrackingService: {
    triggerCheck: (...args: unknown[]) => triggerCheck(...args),
  },
}));

import { handlePost } from "./rank-check";

const BASE = "http://localhost/api/internal/rank-check";
const TOKEN = "test-agency-token";
const PROJECT_ID = "proj-1";
const CONFIG_ID = "2c88bc1f-a9e3-4c32-bdd3-f1b216a78e68";

function post(body: unknown, token = TOKEN) {
  return handlePost(
    new Request(BASE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  mockEnv.AUTH_MODE = "cloudflare_access";
  getProjectForOrganization.mockResolvedValue({ id: PROJECT_ID, domain: "kleanco.ca" });
  listUsers.mockResolvedValue([
    { userId: "u1", userEmail: "ops@niceseo.ai", createdAt: new Date("2020-01-01") },
  ]);
  triggerCheck.mockResolvedValue({ ok: true, runId: "run-1" });
});

describe("internal rank-check handlePost", () => {
  it("returns 503 when token unset", async () => {
    delete mockEnv.AGENCY_SCORE_EXPORT_TOKEN;
    const res = await post({
      projectId: PROJECT_ID,
      configId: CONFIG_ID,
      maxCostCredits: 180,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "agency_score_export_disabled" });
  });

  it("returns 401 on bad token", async () => {
    const res = await post(
      { projectId: PROJECT_ID, configId: CONFIG_ID, maxCostCredits: 180 },
      "wrong",
    );
    expect(res.status).toBe(401);
  });

  it("returns 202 when trigger starts", async () => {
    const res = await post({
      projectId: PROJECT_ID,
      configId: CONFIG_ID,
      maxCostCredits: 180,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: true, runId: "run-1" });
    expect(getProjectForOrganization).toHaveBeenCalledWith(
      "shared-workspace",
      PROJECT_ID,
    );
    expect(triggerCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        configId: CONFIG_ID,
        projectId: PROJECT_ID,
        maxCostCredits: 180,
        billingCustomer: expect.objectContaining({
          organizationId: "shared-workspace",
          userId: "u1",
          projectId: PROJECT_ID,
        }),
      }),
    );
  });

  it("returns 403 on hosted auth mode and does not spend", async () => {
    mockEnv.AUTH_MODE = "hosted";
    const res = await post({
      projectId: PROJECT_ID,
      configId: CONFIG_ID,
      maxCostCredits: 180,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "unsupported_auth_mode" });
    expect(triggerCheck).not.toHaveBeenCalled();
  });

  it("returns 400 when maxCostCredits missing and does not spend", async () => {
    const res = await post({
      projectId: PROJECT_ID,
      configId: CONFIG_ID,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(triggerCheck).not.toHaveBeenCalled();
  });

  it("returns 400 when maxCostCredits is zero and does not spend", async () => {
    const res = await post({
      projectId: PROJECT_ID,
      configId: CONFIG_ID,
      maxCostCredits: 0,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(triggerCheck).not.toHaveBeenCalled();
  });

  it("returns 404 when project not found and does not spend", async () => {
    getProjectForOrganization.mockResolvedValue(null);
    const res = await post({
      projectId: PROJECT_ID,
      configId: CONFIG_ID,
      maxCostCredits: 180,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "project_not_found" });
    expect(getProjectForOrganization).toHaveBeenCalledWith(
      "shared-workspace",
      PROJECT_ID,
    );
    expect(triggerCheck).not.toHaveBeenCalled();
  });

  it("returns 409 when already running", async () => {
    triggerCheck.mockResolvedValue({
      ok: false,
      reason: "already_running",
      blockingRunId: "run-old",
    });
    const res = await post({
      projectId: PROJECT_ID,
      configId: CONFIG_ID,
      maxCostCredits: 180,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      started: false,
      reason: "already_running",
      blockingRunId: "run-old",
    });
  });

  it("returns 400 on validation_failed from service", async () => {
    triggerCheck.mockRejectedValue(
      new AppError("VALIDATION_ERROR", "The current rank check costs 200 credits"),
    );
    const res = await post({
      projectId: PROJECT_ID,
      configId: CONFIG_ID,
      maxCostCredits: 180,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "validation_failed" });
  });
});
