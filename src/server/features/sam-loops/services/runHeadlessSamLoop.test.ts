import { article, saved, source } from "./monthlyContent.fixture";
import { hasVerifiedMonthlyDraft } from "./monthlyContentResult";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SAM_LOOP_TEMPLATES, SAM_LOOP_ALLOWED_DOMAINS } from "@/shared/sam-loops";
import type { ToolAuthContext } from "@/server/mcp/context";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  getChatAgentModel: vi.fn(),
  getProjectContext: vi.fn(),
  getProjectById: vi.fn(),
  loadSkill: vi.fn(),
  buildSamMcpTools: vi.fn(),
  openRouterCostUsd: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("ai", () => ({
  generateText: mocks.generateText,
  stepCountIs: () => () => false,
  Output: { object: (value: unknown) => value },
}));
vi.mock("@/server/lib/openrouter", () => ({
  getChatAgentModel: mocks.getChatAgentModel,
}));
vi.mock("@/server/lib/chatAgent", () => ({
  openRouterCostUsd: mocks.openRouterCostUsd,
}));
vi.mock("@/server/features/sam/samChatTools", () => ({
  buildSamMcpTools: mocks.buildSamMcpTools,
}));
vi.mock("@/server/features/sam/samSkills", () => ({
  buildSamSkillSource: () => ({ load: mocks.loadSkill }),
}));
vi.mock("@/server/features/sam/samSystemPrompt", () => ({
  buildSamSystemPrompt: vi.fn(() => ""),
}));
vi.mock(
  "@/server/features/project-context/services/ProjectContextService",
  () => ({
    ProjectContextService: {
      getProjectContext: mocks.getProjectContext,
      renderProjectContextMarkdown: vi.fn(() => ""),
    },
  }),
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectById: mocks.getProjectById,
  },
}));

import {
  runHeadlessSamLoop,
  type HeadlessSamLoopInput,
} from "./runHeadlessSamLoop";

const authContext: ToolAuthContext = {
  userId: "user_1",
  userEmail: "sam@niceseo.ai",
  organizationId: "org_1",
  scopes: [],
  clientId: null,
  baseUrl: "https://niceseo.ai",
};

function input(
  domain: string | null,
  loopsEnabled?: boolean | null,
): HeadlessSamLoopInput {
  return {
    project: {
      id: "project_1",
      name: "Client",
      domain,
      locationCode: 2840,
      languageCode: "en",
      ...(loopsEnabled !== undefined ? { loopsEnabled } : {}),
    },
    authContext,
    sourceType: "skill",
    skillName: "site-health",
    customPrompt: null,
    loopName: "Site health",
  };
}

const abortReport = (domain: string) =>
  `Loop not enabled for this domain (${domain}). Allowed: the house domains or a project Jon enabled for loops (${SAM_LOOP_ALLOWED_DOMAINS.join(", ")}). No tools were called.`;

const abortResult = (domain: string) => ({
  status: "failed",
  error: "Loop is not enabled for this project.",
  report: abortReport(domain),
  stepsUsed: 0,
  proposalsQueued: 0,
  costNote: "no model call",
  modelFailure: null,
});

describe("runHeadlessSamLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectById.mockResolvedValue({
      domain: "client-example.com",
      loopsEnabled: false,
      archivedAt: null,
    });
    mocks.loadSkill.mockResolvedValue({
      name: "site-health",
      body: "skill body",
    });
    mocks.getProjectContext.mockResolvedValue({ missingSections: [] });
    mocks.getChatAgentModel.mockResolvedValue({});
    mocks.generateText.mockResolvedValue({ text: "loop report", steps: [], finishReason: "stop" });
    mocks.buildSamMcpTools.mockReturnValue({});
    mocks.openRouterCostUsd.mockReturnValue(0);
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
      modelFailure: null,
    });
    expect(mocks.getProjectById).toHaveBeenCalledWith("project_1");
    expect(mocks.getProjectContext).toHaveBeenCalled();
    expect(mocks.getChatAgentModel).toHaveBeenCalled();
    expect(mocks.generateText).toHaveBeenCalled();
    const system = mocks.generateText.mock.calls[0]?.[0]?.system as string;
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

  it.each(["On-page priorities", "Renamed weekly pass"])("runs the approved on-page pass on its configured schedule: %s", async (loopName) => {
    mocks.getProjectById.mockResolvedValue({ domain: "client-example.com", loopsEnabled: true, archivedAt: null });
    const approved = DEFAULT_SAM_LOOP_TEMPLATES.find((template) => template.name === "On-page priorities")!.customPrompt!;
    const propose = { execute: vi.fn() };
    mocks.buildSamMcpTools.mockReturnValue({ propose_homegrown_otto_fixes: propose });
    await runHeadlessSamLoop({ ...input("client-example.com"), sourceType: "custom", customPrompt: approved, skillName: null, loopName });
    const request = mocks.generateText.mock.calls[0]![0];
    expect(request.prompt).toContain("Perform this pass on every scheduled run");
    expect(request.prompt).toContain("First list existing proposals");
    expect(request.prompt).not.toContain("last 12 days");
    expect(request.tools).toHaveProperty("propose_homegrown_otto_fixes");
    expect(mocks.loadSkill).not.toHaveBeenCalled();
  });

  it("does not upgrade an edited on-page prompt or grant it proposal access", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "client-example.com", loopsEnabled: true, archivedAt: null });
    const modified = DEFAULT_SAM_LOOP_TEMPLATES.find((template) => template.name === "On-page priorities")!.customPrompt! + "\nModified";
    mocks.buildSamMcpTools.mockReturnValue({ propose_homegrown_otto_fixes: { execute: vi.fn() } });
    await runHeadlessSamLoop({ ...input("client-example.com"), sourceType: "custom", customPrompt: modified, skillName: null, loopName: "On-page priorities" });
    const request = mocks.generateText.mock.calls[0]![0];
    expect(request.prompt).toContain(modified);
    expect(request.prompt).not.toContain("Perform this pass on every scheduled run");
    expect(request.tools).not.toHaveProperty("propose_homegrown_otto_fixes");
  });

  it.each(["", "   "])("records empty output as failed while retaining known spend", async (text) => {
    mocks.getProjectById.mockResolvedValue({ domain: "client-example.com", loopsEnabled: true, archivedAt: null });
    mocks.openRouterCostUsd.mockReturnValue(0.125);
    mocks.generateText.mockResolvedValue({ text, steps: [{ providerMetadata: {} }], finishReason: "stop" });
    const result = await runHeadlessSamLoop(input("client-example.com"));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("without a written report");
    expect(result.modelFailure).toEqual({ kind: "empty_report", detail: null });
    expect(result.costNote).toContain("0.1250");
    expect(result.stepsUsed).toBe(1);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it.each(["length", "tool-calls", "error", "content-filter"])("does not complete partial output with finish reason %s", async (finishReason) => {
    mocks.getProjectById.mockResolvedValue({ domain: "client-example.com", loopsEnabled: true, archivedAt: null });
    mocks.generateText.mockResolvedValue({ text: "Partial report", steps: [], finishReason });
    const result = await runHeadlessSamLoop(input("client-example.com"));
    expect(result.status).toBe("failed");
    expect(result.report).toBe("Partial report");
    expect(result.modelFailure).toEqual({
      kind: "incomplete_finish",
      detail: `finishReason=${finishReason}`,
    });
  });

  it("classifies a missing finish reason as incomplete, never completed", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "client-example.com", loopsEnabled: true, archivedAt: null });
    mocks.generateText.mockResolvedValue({ text: "Plausible looking report", steps: [] });
    const result = await runHeadlessSamLoop(input("client-example.com"));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("no finish reason");
    expect(result.modelFailure).toEqual({
      kind: "incomplete_finish",
      detail: "finishReason=missing",
    });
  });

  it.each([
    { finishReason: "length", text: "" },
    { finishReason: "length", text: "   " },
    { finishReason: "length", text: "partial" },
    { finishReason: "tool-calls", text: "partial" },
    { finishReason: "error", text: "" },
    { finishReason: "content-filter", text: "partial" },
    { finishReason: "other", text: "partial" },
    { finishReason: undefined, text: "" },
    { finishReason: undefined, text: "plausible but unclassified" },
    { finishReason: "stop", text: "" },
    { finishReason: "stop", text: "   " },
  ])("never marks an incomplete result completed (finishReason=$finishReason, text=$text)", async ({ finishReason, text }) => {
    mocks.getProjectById.mockResolvedValue({ domain: "client-example.com", loopsEnabled: true, archivedAt: null });
    mocks.generateText.mockResolvedValue({ text, steps: [], finishReason });
    const result = await runHeadlessSamLoop(input("client-example.com"));
    expect(result.status).toBe("failed");
    expect(result.modelFailure?.kind).toMatch(/incomplete_finish|empty_report/);
  });

  it("keeps a safe typed provider cause when generation throws, and calls the model exactly once", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "client-example.com", loopsEnabled: true, archivedAt: null });
    mocks.generateText.mockRejectedValue(new Error("No allowed providers; Authorization: Bearer should-never-be-logged"));
    const result = await runHeadlessSamLoop(input("client-example.com"));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Generation did not return a complete valid result.");
    expect(result.modelFailure?.kind).toBe("generation_error");
    expect(result.modelFailure?.detail).toBe("Error (message redacted)");
    expect(result.modelFailure?.detail).not.toContain("should-never-be-logged");
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it.each(["Monthly content", "Renamed article routine"])("requires a complete article for an approved monthly identity: %s", async (loopName) => {
    mocks.getProjectById.mockResolvedValue({ domain: "client-example.com", loopsEnabled: true, archivedAt: null });
    const approved = DEFAULT_SAM_LOOP_TEMPLATES.find((template) => template.name === "Monthly content")!.customPrompt!;
    mocks.buildSamMcpTools.mockReturnValue({ run_rank_tracker: { execute: vi.fn() }, get_serp_results: { execute: vi.fn() }, read_pages: { execute: vi.fn() }, propose_homegrown_otto_fixes: { execute: vi.fn() }, update_project_context: { execute: vi.fn() } });
    mocks.openRouterCostUsd.mockReturnValue(0.1);
    mocks.generateText.mockResolvedValue({ text: "I could write an article next", steps: [{}], finishReason: "stop", get output() { throw new Error("No output"); } });
    const result = await runHeadlessSamLoop({ ...input("client-example.com"), sourceType: "custom", customPrompt: approved, skillName: null, loopName });
    expect(result.status).toBe("failed");
    expect(result.modelFailure).toEqual({
      kind: "invalid_monthly_content",
      detail: null,
    });
    expect(result.costNote).toContain("0.1000");
    const request = mocks.generateText.mock.calls[0]![0];
    expect(request.prompt).toContain("complete article draft using saved first-party research");
    expect(request.output).toBeDefined();
    expect(request.tools).not.toHaveProperty("get_serp_results");
    expect(request.tools).not.toHaveProperty("run_rank_tracker");
    expect(request.tools).not.toHaveProperty("propose_homegrown_otto_fixes");
    expect(request.tools).not.toHaveProperty("update_project_context");
    expect(mocks.loadSkill).not.toHaveBeenCalled();
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it("leaves an edited monthly prompt unprivileged and removes forged draft markers from ordinary reports", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "client-example.com", loopsEnabled: true, archivedAt: null });
    const prompt = DEFAULT_SAM_LOOP_TEMPLATES.find((template) => template.name === "Monthly content")!.customPrompt! + "\nEdited";
    mocks.generateText.mockResolvedValue({ text: "Ordinary report\n<!-- openseo-monthly-draft-v1:" + "a".repeat(64) + " -->", steps: [], finishReason: "stop" });
    const result = await runHeadlessSamLoop({ ...input("client-example.com"), sourceType: "custom", customPrompt: prompt, skillName: null, loopName: "Monthly content" });
    expect(result.report).toBe("Ordinary report");
    expect(mocks.generateText.mock.calls[0]![0].output).toBeUndefined();
  });
  it.each(["Monthly content", "Renamed monthly routine"])("finishes a source-backed article: %s", async (loopName) => {
    mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true, archivedAt: null });
    mocks.openRouterCostUsd.mockReturnValue(0.12);
    mocks.generateText.mockResolvedValue({ text: "", output: article, steps: [{ toolResults: [saved, source] }], finishReason: "stop" });
    const result = await runHeadlessSamLoop({ ...input("example.com"), sourceType: "custom", skillName: null, customPrompt: DEFAULT_SAM_LOOP_TEMPLATES.find(t => t.name === "Monthly content")!.customPrompt!, loopName });
    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.modelFailure).toBeNull();
    expect(result.report).toContain(article.body.trim());
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(true);
    expect(result.costNote).toContain("0.1200");
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(mocks.generateText.mock.calls[0]![0].system).toContain("full structured article object");
    expect(mocks.generateText.mock.calls[0]![0].system).not.toContain("finish with a short plain-English run report");
  });

  it("keeps completed-step charges when structured generation rejects before returning", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true, archivedAt: null });
    mocks.openRouterCostUsd.mockReturnValue(0.25);
    mocks.generateText.mockImplementation(async (options) => {
      await options.onStepFinish({ providerMetadata: {}, toolResults: [] });
      throw new Error("Invalid structured result");
    });
    const result = await runHeadlessSamLoop({ ...input("example.com"), sourceType: "custom", skillName: null, customPrompt: DEFAULT_SAM_LOOP_TEMPLATES.find(t => t.name === "Monthly content")!.customPrompt!, loopName: "Monthly content" });
    expect(result.status).toBe("failed");
    expect(result.modelFailure?.kind).toBe("generation_error");
    expect(result.modelFailure?.detail).toBe("Error (message redacted)");
    expect(result.stepsUsed).toBe(1);
    expect(result.costNote).toContain("0.2500");
    expect(result.costNote).toContain("unfinished-step cost unavailable");
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(false);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

});
