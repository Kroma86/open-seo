import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import {
  abortResult,
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

describe("runHeadlessSamLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultMocks();
  });

  it("returns before any model or tool call when the domain is outside the allowlist", async () => {
    const result = await runHeadlessSamLoop(input("client-example.com", false));

    expect(result).toEqual(abortResult("client-example.com"));
    expect(mocks.getProjectById).toHaveBeenCalledWith("project_1");
    expect(mocks.getChatAgentModel).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.getProjectContext).not.toHaveBeenCalled();
  });

  it("ignores caller loopsEnabled true when the database row is false", async () => {
    mocks.getProjectById.mockResolvedValue({
      domain: "client-example.com",
      loopsEnabled: false,
      archivedAt: null,
    });
    const result = await runHeadlessSamLoop(input("client-example.com", true));

    expect(result).toEqual(abortResult("client-example.com"));
    expect(mocks.getProjectById).toHaveBeenCalledWith("project_1");
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.getChatAgentModel).not.toHaveBeenCalled();
  });

  it("ignores a caller house domain when the database row is a client domain with the flag off", async () => {
    mocks.getProjectById.mockResolvedValue({
      domain: "client-example.com",
      loopsEnabled: false,
      archivedAt: null,
    });
    const result = await runHeadlessSamLoop(input("niceseo.ai", true));

    expect(result).toEqual(abortResult("client-example.com"));
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.getChatAgentModel).not.toHaveBeenCalled();
  });

  it("runs when the database row has loopsEnabled true on a client domain", async () => {
    mocks.getProjectById.mockResolvedValue({
      domain: "client-example.com",
      loopsEnabled: true,
      archivedAt: null,
    });

    const result = await runHeadlessSamLoop(input("client-example.com", false));

    expect(result).toEqual({
      status: "completed",
      error: null,
      report: "loop report",
      stepsUsed: 0,
      proposalsQueued: 0,
      costNote: null,
    });
    expect(mocks.getProjectById).toHaveBeenCalledWith("project_1");
    expect(mocks.getProjectContext).toHaveBeenCalled();
    expect(mocks.getChatAgentModel).toHaveBeenCalled();
    expect(mocks.generateText).toHaveBeenCalled();
    const system = firstGenerateTextRequest().system;
    expect(system).toContain("Do the loop work for this project's own domain.");
    expect(system).not.toContain("If the project domain is not one of them");
  });

  it("aborts when the project row is missing", async () => {
    mocks.getProjectById.mockResolvedValue(null);
    const result = await runHeadlessSamLoop(input("niceseo.ai", true));

    expect(result).toEqual(abortResult("no domain"));
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.getChatAgentModel).not.toHaveBeenCalled();
  });

  it("aborts when the project row is archived", async () => {
    mocks.getProjectById.mockResolvedValue({
      domain: "client-example.com",
      loopsEnabled: true,
      archivedAt: "2026-01-01 00:00:00",
    });
    const result = await runHeadlessSamLoop(input("client-example.com", true));

    expect(result).toEqual(abortResult("client-example.com"));
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.getChatAgentModel).not.toHaveBeenCalled();
  });

  it.each(["On-page priorities", "Renamed weekly pass"])(
    "runs the approved on-page pass on its configured schedule: %s",
    async (loopName) => {
      mocks.getProjectById.mockResolvedValue({
        domain: "client-example.com",
        loopsEnabled: true,
        archivedAt: null,
      });
      const approved = DEFAULT_SAM_LOOP_TEMPLATES.find(
        (template) => template.name === "On-page priorities",
      )!.customPrompt;
      const propose = { execute: vi.fn() };
      mocks.buildSamMcpTools.mockReturnValue({
        propose_homegrown_otto_fixes: propose,
      });
      await runHeadlessSamLoop({
        ...input("client-example.com"),
        sourceType: "custom",
        customPrompt: approved,
        skillName: null,
        loopName,
      });
      const request = firstGenerateTextRequest();
      expect(request.prompt).toContain(
        "Perform this pass on every scheduled run",
      );
      expect(request.prompt).toContain("First list existing proposals");
      expect(request.prompt).not.toContain("last 12 days");
      expect(request.tools).toHaveProperty("propose_homegrown_otto_fixes");
      expect(mocks.loadSkill).not.toHaveBeenCalled();
    },
  );

  it("does not upgrade an edited on-page prompt or grant it proposal access", async () => {
    mocks.getProjectById.mockResolvedValue({
      domain: "client-example.com",
      loopsEnabled: true,
      archivedAt: null,
    });
    const modified =
      DEFAULT_SAM_LOOP_TEMPLATES.find(
        (template) => template.name === "On-page priorities",
      )!.customPrompt + "\nModified";
    mocks.buildSamMcpTools.mockReturnValue({
      propose_homegrown_otto_fixes: { execute: vi.fn() },
    });
    await runHeadlessSamLoop({
      ...input("client-example.com"),
      sourceType: "custom",
      customPrompt: modified,
      skillName: null,
      loopName: "On-page priorities",
    });
    const request = firstGenerateTextRequest();
    expect(request.prompt).toContain(modified);
    expect(request.prompt).not.toContain(
      "Perform this pass on every scheduled run",
    );
    expect(request.tools).not.toHaveProperty("propose_homegrown_otto_fixes");
  });

  it.each(["", "   "])(
    "records empty output as failed while retaining known spend",
    async (text) => {
      mocks.getProjectById.mockResolvedValue({
        domain: "client-example.com",
        loopsEnabled: true,
        archivedAt: null,
      });
      mocks.openRouterCostUsd.mockReturnValue(0.125);
      mocks.generateText.mockResolvedValue({
        text,
        steps: [{ providerMetadata: {} }],
        finishReason: "stop",
      });
      const result = await runHeadlessSamLoop(input("client-example.com"));
      expect(result.status).toBe("failed");
      expect(result.error).toContain("without a written report");
      expect(result.costNote).toContain("0.1250");
      expect(result.stepsUsed).toBe(1);
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["length", "tool-calls", "error", "content-filter"])(
    "does not complete partial output with finish reason %s",
    async (finishReason) => {
      mocks.getProjectById.mockResolvedValue({
        domain: "client-example.com",
        loopsEnabled: true,
        archivedAt: null,
      });
      mocks.generateText.mockResolvedValue({
        text: "Partial report",
        steps: [],
        finishReason,
      });
      const result = await runHeadlessSamLoop(input("client-example.com"));
      expect(result.status).toBe("failed");
      expect(result.report).toBe("Partial report");
    },
  );
});
