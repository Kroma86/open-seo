import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuditStatusTool } from "./site-audit-tools";
import {
  makeToolContext,
  textContent,
  validateAsClientWould,
} from "./tool-test-support";
const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getStatus: vi.fn(),
  getLatestAuditForProject: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/audit/services/AuditService", () => ({
  AuditService: { getStatus: mocks.getStatus },
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: { getLatestAuditForProject: mocks.getLatestAuditForProject },
}));
const projectId = "11111111-1111-4111-8111-111111111111";
const auditId = "22222222-2222-4222-8222-222222222222";
const status = {
  id: auditId,
  startUrl: "https://example.test/",
  status: "completed",
  currentPhase: "completed",
  pagesCrawled: 3,
  pagesTotal: 3,
  lighthouseTotal: 0,
  lighthouseCompleted: 0,
  lighthouseFailed: 0,
  startedAt: "2026-10-15T08:00:00.000Z",
  completedAt: "2026-10-15T08:01:00.000Z",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getProjectForOrganization.mockResolvedValue({ id: projectId });
  mocks.getStatus.mockResolvedValue(status);
  mocks.getLatestAuditForProject.mockResolvedValue({ id: auditId });
});
describe("audit status times", () => {
  it("exposes both recorded timestamps in text and preserves structured output", async () => {
    const r = await getAuditStatusTool.handler(
      { projectId, auditId },
      makeToolContext(),
    );
    expect(textContent(r)).toContain("Started: " + status.startedAt);
    expect(textContent(r)).toContain("finished: " + status.completedAt);
    expect(r.structuredContent).toMatchObject({ status });
    expect(
      validateAsClientWould(
        getAuditStatusTool.config.outputSchema,
        r.structuredContent,
      ).valid,
    ).toBe(true);
    expect(mocks.getStatus).toHaveBeenCalledExactlyOnceWith(auditId, projectId);
  });
  it("does not invent missing times and still resolves the latest audit", async () => {
    mocks.getStatus.mockResolvedValue({
      ...status,
      status: "running",
      startedAt: null,
      completedAt: null,
    });
    const r = await getAuditStatusTool.handler(
      { projectId },
      makeToolContext(),
    );
    expect(textContent(r)).toContain(
      "Started: unknown; finished: not recorded.",
    );
    expect(r.structuredContent).toMatchObject({
      status: { startedAt: null, completedAt: null },
    });
    expect(mocks.getLatestAuditForProject).toHaveBeenCalledExactlyOnceWith(
      projectId,
    );
  });
  it("does not read audit state for an unauthorized project", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);
    await expect(
      getAuditStatusTool.handler({ projectId, auditId }, makeToolContext()),
    ).rejects.toThrow();
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });
});
