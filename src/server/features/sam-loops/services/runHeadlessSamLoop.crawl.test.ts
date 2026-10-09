import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import {
  authContext,
  firstGenerateTextRequest,
  input,
  mocks,
  setDefaultMocks,
} from "./runHeadlessSamLoop.fixture";

const fixture = vi.hoisted(
  () => async () =>
    (await import("./runHeadlessSamLoop.fixture")).mockedModules,
);
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("ai", async () => (await fixture()).ai);
vi.mock("@/server/lib/openrouter", async () => (await fixture()).openrouter);
vi.mock("@/server/lib/chatAgent", async () => (await fixture()).chatAgent);
vi.mock(
  "@/server/features/sam/samChatTools",
  async () => (await fixture()).samChatTools,
);
vi.mock(
  "@/server/features/sam/samSkills",
  async () => (await fixture()).samSkills,
);
vi.mock(
  "@/server/features/sam/samSystemPrompt",
  async () => (await fixture()).samSystemPrompt,
);
vi.mock(
  "@/server/features/project-context/services/ProjectContextService",
  async () => (await fixture()).projectContextService,
);
vi.mock(
  "@/server/features/projects/repositories/ProjectRepository",
  async () => (await fixture()).projectRepository,
);
vi.mock(
  "@/server/features/audit/repositories/AuditRepository",
  async () => (await fixture()).auditRepository,
);

import { runHeadlessSamLoop } from "./runHeadlessSamLoop";

describe("runHeadlessSamLoop crawl readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultMocks();
  });

  it.each(["missing", "stale", "blank", "read-error"])(
    "blocks unusable crawl inputs before model spending: %s",
    async (kind) => {
      mocks.getProjectById.mockResolvedValue({
        domain: "example.com",
        loopsEnabled: true,
        archivedAt: null,
      });
      if (kind === "missing")
        mocks.getLatestAuditForProject.mockResolvedValue(null);
      if (kind === "stale")
        mocks.getLatestAuditForProject.mockResolvedValue({
          id: "old",
          status: "completed",
          startedAt: "2020-01-01T00:00:00Z",
          completedAt: "2020-01-01T01:00:00Z",
        });
      if (kind === "blank")
        mocks.getPagesForAudit.mockResolvedValue([
          {
            url: "https://example.com/",
            statusCode: 200,
            fetchClass: "ok",
            wordCount: 0,
          },
        ]);
      if (kind === "read-error")
        mocks.getLatestAuditForProject.mockRejectedValue(
          new Error("private database detail"),
        );
      const result = await runHeadlessSamLoop(input("example.com", true));
      expect(result.status).toBe("failed");
      expect(result.costNote).toBe("no model call");
      expect(result.report).toContain("Current crawl input unavailable");
      expect(JSON.stringify(result)).not.toContain("private database detail");
      expect(mocks.getChatAgentModel).not.toHaveBeenCalled();
      expect(mocks.buildSamMcpTools).not.toHaveBeenCalled();
      expect(mocks.getProjectContext).not.toHaveBeenCalled();
    },
  );

  it("binds tools and crawl evidence to the saved project domain", async () => {
    mocks.getProjectById.mockResolvedValue({
      domain: "example.com",
      loopsEnabled: true,
      archivedAt: null,
    });
    await runHeadlessSamLoop(input("stale-caller.example", true));
    expect(mocks.buildSamMcpTools).toHaveBeenCalledWith(authContext, {
      id: "project_1",
      domain: "example.com",
    });
    const system = firstGenerateTextRequest().system;
    expect(system).toContain("Crawl input checked before this run:");
    expect(system).toContain("2 usable own-site pages");
    expect(system).toContain("not proof of improved rankings");
    expect(system).toContain("500 words");
  });

  it("keeps rank-only reads independent of crawl readiness", async () => {
    mocks.getProjectById.mockResolvedValue({
      domain: "example.com",
      loopsEnabled: true,
      archivedAt: null,
    });
    mocks.getLatestAuditForProject.mockResolvedValue(null);
    await runHeadlessSamLoop({
      ...input("example.com", true),
      skillName: "rank-slippage",
    });
    expect(mocks.getLatestAuditForProject).not.toHaveBeenCalled();
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it.each([
    "site-health",
    "seo-audit",
    "niceseo-pillars",
    "page-growth",
    "ai-visibility",
  ])("requires current page inventory for %s", async (skillName) => {
    mocks.getProjectById.mockResolvedValue({
      domain: "example.com",
      loopsEnabled: true,
      archivedAt: null,
    });
    mocks.getLatestAuditForProject.mockResolvedValue(null);
    const result = await runHeadlessSamLoop({
      ...input("example.com"),
      skillName,
    });
    expect(result.status).toBe("failed");
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
  it.each([
    "get_audit_pages",
    "get_audit_status",
    "get_audit_issues",
    "Activate seo-audit",
    DEFAULT_SAM_LOOP_TEMPLATES.find((t) => t.name === "On-page priorities")!
      .customPrompt,
  ])("gates custom audit reader %s", async (customPrompt) => {
    mocks.getProjectById.mockResolvedValue({
      domain: "example.com",
      loopsEnabled: true,
      archivedAt: null,
    });
    mocks.getLatestAuditForProject.mockResolvedValue(null);
    const result = await runHeadlessSamLoop({
      ...input("example.com"),
      sourceType: "custom",
      skillName: null,
      customPrompt,
    });
    expect(result.status).toBe("failed");
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
  it.each(["Monthly content", "Keyword portfolio"])(
    "does not require crawl data for %s",
    async (name) => {
      mocks.getProjectById.mockResolvedValue({
        domain: "example.com",
        loopsEnabled: true,
        archivedAt: null,
      });
      mocks.getLatestAuditForProject.mockResolvedValue(null);
      const template = DEFAULT_SAM_LOOP_TEMPLATES.find((t) => t.name === name);
      if (!template || !("customPrompt" in template)) {
        throw new Error(`${name} has no custom prompt`);
      }
      await runHeadlessSamLoop({
        ...input("example.com"),
        sourceType: "custom",
        skillName: null,
        customPrompt: template.customPrompt,
      });
      expect(mocks.getLatestAuditForProject).not.toHaveBeenCalled();
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    },
  );
});
