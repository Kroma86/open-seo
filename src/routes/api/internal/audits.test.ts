import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";

const {
  mockEnv,
  listMembers,
  getProjectForOrganization,
  getStatus,
  getHistory,
  getLatestAuditForProject,
  startAudit,
  resolveAuditLimitTier,
} = vi.hoisted(() => {
  const listMembers = vi.fn();
  return {
    mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string; AUTH_MODE?: string },
    listMembers,
    getProjectForOrganization: vi.fn(),
    getStatus: vi.fn(),
    getHistory: vi.fn(),
    getLatestAuditForProject: vi.fn(),
    startAudit: vi.fn(),
    resolveAuditLimitTier: vi.fn(),
  };
});

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

vi.mock("@/db", () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(listMembers()).then(onFulfilled, onRejected),
  };
  return { db: { select: () => chain } };
});

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: (...args: unknown[]) =>
      getProjectForOrganization(...args),
  },
}));

vi.mock("@/server/features/audit/services/AuditService", () => ({
  AuditService: {
    getStatus: (...args: unknown[]) => getStatus(...args),
    getHistory: (...args: unknown[]) => getHistory(...args),
    startAudit: (...args: unknown[]) => startAudit(...args),
    resolveAuditLimitTier: (...args: unknown[]) => resolveAuditLimitTier(...args),
  },
}));

vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    getLatestAuditForProject: (...args: unknown[]) =>
      getLatestAuditForProject(...args),
  },
}));

import { handleGet, handlePost } from "./audits";

const TOKEN = "test-export-token";
const BASE = "http://localhost/api/internal/audits";
const ORG_ID = "shared-workspace";
const PROJECT_ID = "project_1";

const PROJECT = {
  id: PROJECT_ID,
  name: "Acme",
  domain: "example.com",
  locationCode: 2840,
  languageCode: "en",
  createdAt: "2026-01-01 00:00:00",
};

const EARLY_MEMBER = {
  userId: "user_early",
  userEmail: "early@example.com",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const LATE_MEMBER = {
  userId: "user_late",
  userEmail: "late@example.com",
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
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

function expectAuditServicesIdle() {
  expect(getStatus).not.toHaveBeenCalled();
  expect(getHistory).not.toHaveBeenCalled();
  expect(getLatestAuditForProject).not.toHaveBeenCalled();
  expect(startAudit).not.toHaveBeenCalled();
  expect(resolveAuditLimitTier).not.toHaveBeenCalled();
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
  listMembers.mockResolvedValue([LATE_MEMBER, EARLY_MEMBER]);
  getStatus.mockResolvedValue({ id: "audit_1", status: "completed" });
  getHistory.mockResolvedValue([]);
  getLatestAuditForProject.mockResolvedValue(null);
  startAudit.mockResolvedValue({ auditId: "audit_1" });
  resolveAuditLimitTier.mockResolvedValue("self_hosted");
});

describe("internal audits auth", () => {
  it("returns 503 agency_score_export_disabled when token unset", async () => {
    delete mockEnv.AGENCY_SCORE_EXPORT_TOKEN;
    const res = await handleGet(get(`?projectId=${PROJECT_ID}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "agency_score_export_disabled",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(getProjectForOrganization).not.toHaveBeenCalled();
    expectAuditServicesIdle();
  });

  it("returns 401 when bearer is wrong", async () => {
    const res = await handlePost(
      post(
        { projectId: PROJECT_ID, startUrl: "https://example.com" },
        { authorization: "Bearer wrong-token" },
      ),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(getProjectForOrganization).not.toHaveBeenCalled();
    expectAuditServicesIdle();
  });

  it("refuses both verbs with 403 under AUTH_MODE=hosted", async () => {
    mockEnv.AUTH_MODE = "hosted";

    const listed = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(listed.status).toBe(403);
    expect(await listed.json()).toEqual({ error: "unsupported_auth_mode" });

    const created = await handlePost(
      post({ projectId: PROJECT_ID, startUrl: "https://example.com" }, auth),
    );
    expect(created.status).toBe(403);
    expect(await created.json()).toEqual({ error: "unsupported_auth_mode" });
    expect(getProjectForOrganization).not.toHaveBeenCalled();
    expectAuditServicesIdle();
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

describe("internal audits ownership", () => {
  it("returns 404 when projectId is not in the resolved org", async () => {
    const listed = await handleGet(get("?projectId=other_project", auth));
    expect(listed.status).toBe(404);
    expect(await listed.json()).toEqual({ error: "project_not_found" });

    const created = await handlePost(
      post({ projectId: "other_project", startUrl: "https://example.com" }, auth),
    );
    expect(created.status).toBe(404);
    expect(await created.json()).toEqual({ error: "project_not_found" });
    expectAuditServicesIdle();
    expect(listMembers).not.toHaveBeenCalled();
  });
});

describe("internal audits handleGet", () => {
  it("returns 400 invalid_query when projectId is missing", async () => {
    const res = await handleGet(get("", auth));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_query" });
    expect(getProjectForOrganization).not.toHaveBeenCalled();
    expectAuditServicesIdle();
  });

  it("returns getStatus payload when auditId is provided", async () => {
    const status = {
      id: "audit_1",
      startUrl: "https://example.com",
      status: "running",
    };
    getStatus.mockResolvedValue(status);

    const res = await handleGet(
      get(`?projectId=${PROJECT_ID}&auditId=audit_1`, auth),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ audit: status });
    expect(getStatus).toHaveBeenCalledWith("audit_1", PROJECT_ID);
    expect(getHistory).not.toHaveBeenCalled();
    expect(getLatestAuditForProject).not.toHaveBeenCalled();
  });

  it("returns latest and history when auditId is omitted", async () => {
    const latest = { id: "audit_2", status: "completed" };
    const history = [{ id: "audit_2" }, { id: "audit_1" }];
    getLatestAuditForProject.mockResolvedValue(latest);
    getHistory.mockResolvedValue(history);

    const res = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ latest, history });
    expect(getProjectForOrganization).toHaveBeenCalledWith(
      "shared-workspace",
      PROJECT_ID,
    );
    expect(getLatestAuditForProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(getHistory).toHaveBeenCalledWith(PROJECT_ID);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("returns latest null and empty history when the project has no audits", async () => {
    getLatestAuditForProject.mockResolvedValue(null);
    getHistory.mockResolvedValue([]);

    const res = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ latest: null, history: [] });
  });

  it("returns 404 audit_not_found when getStatus throws NOT_FOUND", async () => {
    getStatus.mockRejectedValue(new AppError("NOT_FOUND", "Audit not found"));

    const res = await handleGet(
      get(`?projectId=${PROJECT_ID}&auditId=missing`, auth),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "audit_not_found" });
  });
});

describe("internal audits handlePost", () => {
  it("starts an audit as the earliest org member and returns 202", async () => {
    const res = await handlePost(
      post({ projectId: PROJECT_ID, startUrl: "https://example.com" }, auth),
    );
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ auditId: "audit_1" });
    expect(resolveAuditLimitTier).toHaveBeenCalledWith(ORG_ID);
    expect(startAudit).toHaveBeenCalledWith({
      actorUserId: "user_early",
      billingCustomer: {
        organizationId: ORG_ID,
        userEmail: "early@example.com",
        userId: "user_early",
        projectId: PROJECT_ID,
      },
      projectId: PROJECT_ID,
      startUrl: "https://example.com",
      maxPages: 50,
      lighthouseStrategy: "auto",
      limitTier: "self_hosted",
    });
  });

  it("returns 409 when the organization has no members", async () => {
    listMembers.mockResolvedValueOnce([]);

    const res = await handlePost(
      post({ projectId: PROJECT_ID, startUrl: "https://example.com" }, auth),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_actor_available" });
    expect(startAudit).not.toHaveBeenCalled();
    expect(resolveAuditLimitTier).not.toHaveBeenCalled();
  });

  it("returns 400 validation_failed on VALIDATION_ERROR", async () => {
    startAudit.mockRejectedValue(
      new AppError("VALIDATION_ERROR", "Start URL is blocked"),
    );

    const res = await handlePost(
      post({ projectId: PROJECT_ID, startUrl: "https://example.com" }, auth),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "validation_failed",
      detail: "Start URL is blocked",
    });
  });
});
