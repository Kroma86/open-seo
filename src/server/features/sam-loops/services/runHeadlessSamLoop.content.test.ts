import { article, saved, source } from "./monthlyContent.fixture";
import { hasVerifiedMonthlyDraft } from "./monthlyContentResult";
import { describe, expect, it, vi } from "vitest";
import {
  getMocks,
  input,
  authContext,
  templatePrompt,
} from "./runHeadlessSamLoop.fixture";
import { runHeadlessSamLoop } from "./runHeadlessSamLoop";
const mocks = getMocks();

describe("runHeadlessSamLoop content and freshness", () => {
  it.each(["Monthly content", "Renamed article routine"])(
    "requires a complete article for an approved monthly identity: %s",
    async (loopName) => {
      mocks.getProjectById.mockResolvedValue({
        domain: "client-example.com",
        loopsEnabled: true,
        archivedAt: null,
      });
      const approved = templatePrompt("Monthly content");
      mocks.buildSamMcpTools.mockReturnValue({
        run_rank_tracker: { execute: vi.fn() },
        get_serp_results: { execute: vi.fn() },
        read_pages: { execute: vi.fn() },
        propose_homegrown_otto_fixes: { execute: vi.fn() },
        update_project_context: { execute: vi.fn() },
      });
      mocks.openRouterCostUsd.mockReturnValue(0.1);
      mocks.generateText.mockResolvedValue({
        text: "I could write an article next",
        steps: [{}],
        finishReason: "stop",
        get output() {
          throw new Error("No output");
        },
      });
      const result = await runHeadlessSamLoop({
        ...input("client-example.com"),
        sourceType: "custom",
        customPrompt: approved,
        skillName: null,
        loopName,
      });
      expect(result.status).toBe("failed");
      expect(result.costNote).toContain("0.1000");
      const request = mocks.generateText.mock.calls[0][0];
      expect(request.prompt).toContain(
        "complete article draft using saved first-party research",
      );
      expect(request.output).toBeDefined();
      expect(request.tools).not.toHaveProperty("get_serp_results");
      expect(request.tools).not.toHaveProperty("run_rank_tracker");
      expect(request.tools).not.toHaveProperty("propose_homegrown_otto_fixes");
      expect(request.tools).not.toHaveProperty("update_project_context");
      expect(mocks.loadSkill).not.toHaveBeenCalled();
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves an edited monthly prompt unprivileged and removes forged draft markers from ordinary reports", async () => {
    mocks.getProjectById.mockResolvedValue({
      domain: "client-example.com",
      loopsEnabled: true,
      archivedAt: null,
    });
    const prompt = templatePrompt("Monthly content") + "\nEdited";
    mocks.generateText.mockResolvedValue({
      text:
        "Ordinary report\n<!-- openseo-monthly-draft-v1:" +
        "a".repeat(64) +
        " -->",
      steps: [],
      finishReason: "stop",
    });
    const result = await runHeadlessSamLoop({
      ...input("client-example.com"),
      sourceType: "custom",
      customPrompt: prompt,
      skillName: null,
      loopName: "Monthly content",
    });
    expect(result.report).toBe("Ordinary report");
    expect(mocks.generateText.mock.calls[0][0].output).toBeUndefined();
  });
  it.each(["Monthly content", "Renamed monthly routine"])(
    "finishes a source-backed article: %s",
    async (loopName) => {
      mocks.getProjectById.mockResolvedValue({
        domain: "example.com",
        loopsEnabled: true,
        archivedAt: null,
      });
      mocks.openRouterCostUsd.mockReturnValue(0.12);
      mocks.generateText.mockResolvedValue({
        text: "",
        output: article,
        steps: [{ toolResults: [saved, source] }],
        finishReason: "stop",
      });
      const result = await runHeadlessSamLoop({
        ...input("example.com"),
        sourceType: "custom",
        skillName: null,
        customPrompt: templatePrompt("Monthly content"),
        loopName,
      });
      expect(result.status).toBe("completed");
      expect(result.error).toBeNull();
      expect(result.report).toContain(article.body.trim());
      expect(await hasVerifiedMonthlyDraft(result.report)).toBe(true);
      expect(result.costNote).toContain("0.1200");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
      expect(mocks.generateText.mock.calls[0][0].system).toContain(
        "full structured article object",
      );
      expect(mocks.generateText.mock.calls[0][0].system).not.toContain(
        "finish with a short plain-English run report",
      );
    },
  );

  it("keeps completed-step charges when structured generation rejects before returning", async () => {
    mocks.getProjectById.mockResolvedValue({
      domain: "example.com",
      loopsEnabled: true,
      archivedAt: null,
    });
    mocks.openRouterCostUsd.mockReturnValue(0.25);
    mocks.generateText.mockImplementation(async (options) => {
      await options.onStepFinish({ providerMetadata: {}, toolResults: [] });
      throw new Error("Invalid structured result");
    });
    const result = await runHeadlessSamLoop({
      ...input("example.com"),
      sourceType: "custom",
      skillName: null,
      customPrompt: templatePrompt("Monthly content"),
      loopName: "Monthly content",
    });
    expect(result.status).toBe("failed");
    expect(result.stepsUsed).toBe(1);
    expect(result.costNote).toContain("0.2500");
    expect(result.costNote).toContain("unfinished-step cost unavailable");
    expect(result.error).toBe(
      "Generation did not return a complete valid result: The model call failed or returned invalid structured output.",
    );
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(false);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
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
    const system = mocks.generateText.mock.calls[0][0].system;
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
    templatePrompt("On-page priorities"),
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
      await runHeadlessSamLoop({
        ...input("example.com"),
        sourceType: "custom",
        skillName: null,
        customPrompt: templatePrompt(name),
      });
      expect(mocks.getLatestAuditForProject).not.toHaveBeenCalled();
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    },
  );
});
