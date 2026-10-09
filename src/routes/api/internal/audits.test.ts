import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import type { AuditService } from "@/server/features/audit/services/AuditService";
import type { ProjectService } from "@/server/features/projects/services/ProjectService";
import { AppError } from "@/server/lib/errors";
import type { ActorRow, MockEnv } from "./internal-route-test-support";

const {
  mockEnv,
  listMembers,
  listUsers,
  getProjectForOrganization,
  getStatus,
  getHistory,
  getLatestAuditForProject,
  startAudit,
  resolveAuditLimitTier,
} = vi.hoisted(() => ({
  mockEnv: {} as MockEnv,
  listMembers: vi.fn<() => Promise<ActorRow[]>>(),
  listUsers: vi.fn<() => Promise<ActorRow[]>>(),
  getProjectForOrganization:
    vi.fn<(typeof ProjectService)["getProjectForOrganization"]>(),
  getStatus: vi.fn<(typeof AuditService)["getStatus"]>(),
  getHistory: vi.fn<(typeof AuditService)["getHistory"]>(),
  getLatestAuditForProject:
    vi.fn<(typeof AuditRepository)["getLatestAuditForProject"]>(),
  startAudit: vi.fn<(typeof AuditService)["startAudit"]>(),
  resolveAuditLimitTier:
    vi.fn<(typeof AuditService)["resolveAuditLimitTier"]>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

vi.mock("@/db", async () => {
  const { createActorDb } = await import("./internal-route-test-support");
  return { db: createActorDb({ listMembers, listUsers }) };
});

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { getProjectForOrganization },
}));

vi.mock("@/server/features/audit/services/AuditService", () => ({
  AuditService: { getStatus, getHistory, startAudit, resolveAuditLimitTier },
}));

vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: { getLatestAuditForProject },
}));

import {
  auth,
  EARLY_MEMBER,
  LATE_MEMBER,
  ORG_ID,
  PROJECT,
  PROJECT_ID,
  requestBuilders,
  TOKEN,
} from "./internal-route-test-support";
import {
  AUDIT,
  historyEntry,
  STARTED_AUDIT_ID,
  STATUS,
} from "./audits-test-fixtures";
import { handleGet, handlePost } from "./audits";

const { get, post } = requestBuilders("http://localhost/api/internal/audits");

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
  listUsers.mockResolvedValue([LATE_MEMBER, EARLY_MEMBER]);
  getStatus.mockResolvedValue({ ...STATUS, status: "completed" });
  getHistory.mockResolvedValue([]);
  getLatestAuditForProject.mockResolvedValue(undefined);
  startAudit.mockResolvedValue({ auditId: STARTED_AUDIT_ID });
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

  it("starts an audit as an org member under AUTH_MODE=local_noauth, ignoring the user table", async () => {
    mockEnv.AUTH_MODE = "local_noauth";
    listUsers.mockResolvedValue([
      {
        userId: "user_other",
        userEmail: "other@example.com",
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
    ]);
    listMembers.mockResolvedValue([EARLY_MEMBER]);

    const res = await handlePost(
      post({ projectId: PROJECT_ID, startUrl: "https://example.com" }, auth),
    );
    expect(res.status).toBe(202);
    expect(startAudit.mock.lastCall?.[0]).toMatchObject({
      actorUserId: "user_early",
      billingCustomer: {
        organizationId: "delegated-local-admin",
        userId: "user_early",
        userEmail: "early@example.com",
      },
    });
    expect(listMembers).toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
  });
});

describe("internal audits ownership", () => {
  it("returns 404 when projectId is not in the resolved org", async () => {
    const listed = await handleGet(get("?projectId=other_project", auth));
    expect(listed.status).toBe(404);
    expect(await listed.json()).toEqual({ error: "project_not_found" });

    const created = await handlePost(
      post(
        { projectId: "other_project", startUrl: "https://example.com" },
        auth,
      ),
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
    const status = STATUS;
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
    const latest = { ...AUDIT, id: "audit_2", status: "completed" as const };
    const history = [historyEntry("audit_2"), historyEntry("audit_1")];
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
    getLatestAuditForProject.mockResolvedValue(undefined);
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
    expect(await res.json()).toEqual({ auditId: STARTED_AUDIT_ID });
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
    mockEnv.AUTH_MODE = "local_noauth";
    listMembers.mockResolvedValueOnce([]);

    const res = await handlePost(
      post({ projectId: PROJECT_ID, startUrl: "https://example.com" }, auth),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_actor_available" });
    expect(startAudit).not.toHaveBeenCalled();
    expect(resolveAuditLimitTier).not.toHaveBeenCalled();
    expect(listMembers).toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
  });

  it("starts an audit as a deployment user when AUTH_MODE=cloudflare_access even with zero members", async () => {
    mockEnv.AUTH_MODE = "cloudflare_access";
    listMembers.mockResolvedValue([]);
    listUsers.mockResolvedValue([
      {
        userId: "user_solo",
        userEmail: "solo@example.com",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const res = await handlePost(
      post({ projectId: PROJECT_ID, startUrl: "https://example.com" }, auth),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ auditId: STARTED_AUDIT_ID });
    expect(startAudit.mock.lastCall?.[0]).toMatchObject({
      actorUserId: "user_solo",
      billingCustomer: {
        organizationId: ORG_ID,
        userId: "user_solo",
        userEmail: "solo@example.com",
      },
    });
    expect(listUsers).toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();
  });

  it("returns 409 when AUTH_MODE=cloudflare_access and there are no users", async () => {
    mockEnv.AUTH_MODE = "cloudflare_access";
    listMembers.mockResolvedValue([EARLY_MEMBER]);
    listUsers.mockResolvedValue([]);

    const res = await handlePost(
      post({ projectId: PROJECT_ID, startUrl: "https://example.com" }, auth),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_actor_available" });
    expect(startAudit).not.toHaveBeenCalled();
    expect(resolveAuditLimitTier).not.toHaveBeenCalled();
    expect(listUsers).toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();
  });

  it("skips blank-email users under AUTH_MODE=cloudflare_access and starts as the next user with an email", async () => {
    mockEnv.AUTH_MODE = "cloudflare_access";
    listUsers.mockResolvedValue([
      {
        userId: "u1",
        userEmail: "",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        userId: "u2",
        userEmail: "ops@example.com",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ]);

    const res = await handlePost(
      post({ projectId: PROJECT_ID, startUrl: "https://example.com" }, auth),
    );
    expect(res.status).toBe(202);
    expect(startAudit.mock.lastCall?.[0]).toMatchObject({
      actorUserId: "u2",
      billingCustomer: {
        userId: "u2",
        userEmail: "ops@example.com",
      },
    });
  });

  it("returns 409 when AUTH_MODE=cloudflare_access and the only user has a null email", async () => {
    mockEnv.AUTH_MODE = "cloudflare_access";
    listUsers.mockResolvedValue([
      {
        userId: "u1",
        userEmail: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const res = await handlePost(
      post({ projectId: PROJECT_ID, startUrl: "https://example.com" }, auth),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_actor_available" });
    expect(startAudit).not.toHaveBeenCalled();
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
