import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import { article, saved, source } from "./monthlyContent.fixture";
import { hasVerifiedMonthlyDraft } from "./monthlyContentResult";
import {
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

describe("runHeadlessSamLoop monthly content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultMocks();
  });

  it.each(["Monthly content", "Renamed article routine"])(
    "requires a complete article for an approved monthly identity: %s",
    async (loopName) => {
      mocks.getProjectById.mockResolvedValue({
        domain: "client-example.com",
        loopsEnabled: true,
        archivedAt: null,
      });
      const approved = DEFAULT_SAM_LOOP_TEMPLATES.find(
        (template) => template.name === "Monthly content",
      )!.customPrompt;
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
      const request = firstGenerateTextRequest();
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
    const prompt =
      DEFAULT_SAM_LOOP_TEMPLATES.find(
        (template) => template.name === "Monthly content",
      )!.customPrompt + "\nEdited";
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
    expect(firstGenerateTextRequest().output).toBeUndefined();
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
        customPrompt: DEFAULT_SAM_LOOP_TEMPLATES.find(
          (t) => t.name === "Monthly content",
        )!.customPrompt,
        loopName,
      });
      expect(result.status).toBe("completed");
      expect(result.error).toBeNull();
      expect(result.report).toContain(article.body.trim());
      expect(await hasVerifiedMonthlyDraft(result.report)).toBe(true);
      expect(result.costNote).toContain("0.1200");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
      expect(firstGenerateTextRequest().system).toContain(
        "full structured article object",
      );
      expect(firstGenerateTextRequest().system).not.toContain(
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
      customPrompt: DEFAULT_SAM_LOOP_TEMPLATES.find(
        (t) => t.name === "Monthly content",
      )!.customPrompt,
      loopName: "Monthly content",
    });
    expect(result.status).toBe("failed");
    expect(result.stepsUsed).toBe(1);
    expect(result.costNote).toContain("0.2500");
    expect(result.costNote).toContain("unfinished-step cost unavailable");
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(false);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });
});
