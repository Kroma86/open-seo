import { article, saved, source } from "./monthlyContent.fixture";
import { hasVerifiedMonthlyDraft, validateMonthlyContent } from "./monthlyContentResult";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SAM_LOOP_TEMPLATES, SAM_LOOP_ALLOWED_DOMAINS } from "@/shared/sam-loops";
import type { ToolAuthContext } from "@/server/mcp/context";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  getChatAgentModel: vi.fn(),
  getProjectContext: vi.fn(),
  getProjectById: vi.fn(),
  getLatestAuditForProject: vi.fn(),
  getPagesForAudit: vi.fn(),
  loadSkill: vi.fn(),
  buildSamMcpTools: vi.fn(),
  openRouterCostUsd: vi.fn(),
  getCompletedMonthlyReports: vi.fn(),
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
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    getLatestAuditForProject: mocks.getLatestAuditForProject,
    getPagesForAudit: mocks.getPagesForAudit,
  },
}));
vi.mock("@/server/features/sam-loops/repositories/SamLoopRepository", () => ({
  SamLoopRepository: { getCompletedMonthlyReports: mocks.getCompletedMonthlyReports },
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
});

describe("runHeadlessSamLoop", () => {
  afterEach(() => vi.unstubAllEnvs());
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
    mocks.getLatestAuditForProject.mockResolvedValue({
      id: "audit_current", status: "completed",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: new Date(Date.now() - 30_000).toISOString(),
    });
    mocks.getPagesForAudit.mockImplementation(async () => {
      const project = await mocks.getProjectById.mock.results.at(-1)?.value;
      return ["/", "/services"].map(path => ({
        url: `https://${project.domain}${path}`, statusCode: 200,
        fetchClass: "ok", wordCount: 200,
      }));
    });
    mocks.getChatAgentModel.mockResolvedValue({ modelId: "minimax/minimax-m3" });
    mocks.generateText.mockResolvedValue({ text: "loop report", steps: [] });
    mocks.buildSamMcpTools.mockReturnValue({ list_saved_keywords: { execute: vi.fn().mockResolvedValue(saved.output) } });
    mocks.openRouterCostUsd.mockReturnValue(0);
    mocks.getCompletedMonthlyReports.mockResolvedValue([]);
  });

  it("returns before any model or tool call when the domain is outside the allowlist", async () => {
    const result = await runHeadlessSamLoop(input("client-example.com", false));

    expect(result).toEqual(abortResult("client-example.com"));
    expect(mocks.getProjectById).toHaveBeenCalledWith("project_1");
    expect(mocks.getChatAgentModel).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.getProjectContext).not.toHaveBeenCalled();
  });

  it("retains completed observations when the last length-limited step has no text", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true });
    mocks.generateText.mockResolvedValue({ text: "", finishReason: "length", steps: [
      { text: "Measured 0 of 5 prompts on September 20.", toolResults: [] },
      { text: "", toolResults: [{ toolName: "get_audit_pages", output: { data: { rows: [] } } }] },
    ] });
    const result = await runHeadlessSamLoop(input("example.com"));
    expect(result.status).toBe("failed");
    expect(result.report).toContain("INCOMPLETE");
    expect(result.report).toContain("Measured 0 of 5 prompts");
    expect(result.report).toContain("get_audit_pages");
    expect(mocks.generateText.mock.calls[0]![0].maxOutputTokens).toBe(8000);
  });

  it("checkpoints partial observations before a later generation exception", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true });
    const onProgress = vi.fn().mockResolvedValue(undefined);
    mocks.generateText.mockImplementation(async (options) => {
      await options.onStepFinish({ text: "Saved observation before interruption.", toolResults: [] });
      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ report: expect.stringContaining("Saved observation"), stepsUsed: 1 }));
      throw new Error("private upstream detail");
    });
    const result = await runHeadlessSamLoop({ ...input("example.com"), onProgress });
    expect(result.status).toBe("failed");
    expect(result.report).toContain("Saved observation");
    expect(result.report).not.toContain("private upstream detail");
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(false);
  });

  it("chooses the monthly target from saved data before generation", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true });
    const read = vi.fn().mockResolvedValue(saved.output);
    mocks.buildSamMcpTools.mockReturnValue({ list_saved_keywords: { execute: read } });
    mocks.generateText.mockResolvedValue({ text: "", output: article, steps: [{ toolResults: [source] }], finishReason: "stop" });
    const result = await runHeadlessSamLoop({ ...input("example.com"), sourceType: "custom", skillName: null, customPrompt: DEFAULT_SAM_LOOP_TEMPLATES.find(t => t.name === "Monthly content")!.customPrompt! });
    expect(read).toHaveBeenCalledTimes(1);
    expect(mocks.generateText.mock.calls[0]![0].prompt).toContain('Selected targetKeyword: "drain cleaning"');
    expect(result.status).toBe("completed");
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(true);
  });

  it("uses verified project history to avoid repeating a monthly target", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true });
    const previous = await validateMonthlyContent(article, [{ toolResults: [saved, source] }], "example.com");
    mocks.getCompletedMonthlyReports.mockResolvedValue([{ report: previous.report }]);
    mocks.buildSamMcpTools.mockReturnValue({ list_saved_keywords: { execute: vi.fn().mockResolvedValue({ data: { rows: [{ keyword: "drain cleaning" }, { keyword: "drain inspection" }] } }) } });
    mocks.generateText.mockResolvedValue({ text: "", output: { ...article, targetKeyword: "drain inspection" }, steps: [{ toolResults: [source] }], finishReason: "stop" });
    const result = await runHeadlessSamLoop({ ...input("example.com"), sourceType: "custom", skillName: null, customPrompt: DEFAULT_SAM_LOOP_TEMPLATES.find(t => t.name === "Monthly content")!.customPrompt! });
    expect(mocks.getCompletedMonthlyReports).toHaveBeenCalledWith("project_1");
    expect(mocks.generateText.mock.calls[0]![0].prompt).toContain('Selected targetKeyword: "drain inspection"');
    expect(result.status).toBe("completed");
  });

  it("does not abort generation when an intermediate checkpoint fails", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true });
    mocks.generateText.mockImplementation(async options => {
      await options.onStepFinish({ text: "Partial observation", toolResults: [] });
      return { text: "Complete report", steps: [], finishReason: "stop" };
    });
    const result = await runHeadlessSamLoop({ ...input("example.com"), onProgress: vi.fn().mockRejectedValue(new Error("private DB error")) });
    expect(result.status).toBe("completed");
    expect(result.report).toBe("Complete report");
    expect(result.costNote).toContain("checkpoint");
    expect(result.costNote).not.toContain("private DB error");
  });

  it("finishes an exhausted monthly portfolio without generating another article", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true });
    const previous = await validateMonthlyContent(article, [{ toolResults: [saved, source] }], "example.com");
    mocks.getCompletedMonthlyReports.mockResolvedValue([{ report: previous.report }]);
    mocks.buildSamMcpTools.mockReturnValue({
      list_saved_keywords: { execute: vi.fn().mockResolvedValue(saved.output) },
      get_rank_tracker: { execute: vi.fn().mockResolvedValue({ data: { configs: [] } }) },
      get_search_console_performance: { execute: vi.fn().mockResolvedValue({ data: { ok: false, reason: "not_connected" } }) },
    });
    const result = await runHeadlessSamLoop({ ...input("example.com"), sourceType: "custom", skillName: null, customPrompt: DEFAULT_SAM_LOOP_TEMPLATES.find(t => t.name === "Monthly content")!.customPrompt! });
    expect(result.status).toBe("completed");
    expect(result.report).toContain("NO NEW TOPIC");
    expect(result.report).not.toContain("NO DATA");
    expect(mocks.getChatAgentModel).not.toHaveBeenCalled();
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(false);
  });

  it("finishes with NO DATA and no model call when all topic sources are empty or disconnected", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true });
    mocks.buildSamMcpTools.mockReturnValue({
      list_saved_keywords: { execute: vi.fn().mockResolvedValue({ data: { rows: [] } }) },
      get_rank_tracker: { execute: vi.fn().mockResolvedValue({ data: { configs: [] } }) },
      get_search_console_performance: { execute: vi.fn().mockResolvedValue({ data: { ok: false, reason: "not_connected" } }) },
    });
    const result = await runHeadlessSamLoop({ ...input("example.com"), sourceType: "custom", skillName: null, customPrompt: DEFAULT_SAM_LOOP_TEMPLATES.find(t => t.name === "Monthly content")!.customPrompt! });
    expect(result.status).toBe("completed");
    expect(result.report).toContain("NO DATA");
    expect(result.costNote).toBe("no model call");
    expect(mocks.getChatAgentModel).not.toHaveBeenCalled();
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(false);
  });

  it("marks stale audit evidence in the saved report only when explicitly enabled", async () => {
    vi.stubEnv("SAM_LOOP_ALLOW_STALE_AUDIT", "true");
    mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true });
    mocks.getLatestAuditForProject.mockResolvedValue({ id: "old", status: "completed", startedAt: "2026-09-01T00:00:00Z", completedAt: "2026-09-01T00:01:00Z" });
    const result = await runHeadlessSamLoop(input("example.com"));
    expect(result.status).toBe("completed");
    expect(result.report).toContain("STALE AUDIT");
    expect(result.report).toContain("2026-09-01");
  });

  it.each(["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY"])("refuses even an empty forbidden credential variable: %s", async name => {
    vi.stubEnv(name, "");
    await expect(runHeadlessSamLoop(input("example.com"))).rejects.toThrow("API-key environment refused");
    expect(mocks.getChatAgentModel).not.toHaveBeenCalled();
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
    expect(result.costNote).toContain("0.1250");
    expect(result.stepsUsed).toBe(1);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it.each(["length", "tool-calls", "error", "content-filter"])("does not complete partial output with finish reason %s", async (finishReason) => {
    mocks.getProjectById.mockResolvedValue({ domain: "client-example.com", loopsEnabled: true, archivedAt: null });
    mocks.generateText.mockResolvedValue({ text: "Partial report", steps: [], finishReason });
    const result = await runHeadlessSamLoop(input("client-example.com"));
    expect(result.status).toBe("failed");
    expect(result.report).toContain("Partial report");
    expect(result.report).toContain("INCOMPLETE");
  });

  it.each(["Monthly content", "Renamed article routine"])("requires a complete article for an approved monthly identity: %s", async (loopName) => {
    mocks.getProjectById.mockResolvedValue({ domain: "client-example.com", loopsEnabled: true, archivedAt: null });
    const approved = DEFAULT_SAM_LOOP_TEMPLATES.find((template) => template.name === "Monthly content")!.customPrompt!;
    mocks.buildSamMcpTools.mockReturnValue({ list_saved_keywords: { execute: vi.fn().mockResolvedValue(saved.output) }, run_rank_tracker: { execute: vi.fn() }, get_serp_results: { execute: vi.fn() }, read_pages: { execute: vi.fn() }, propose_homegrown_otto_fixes: { execute: vi.fn() }, update_project_context: { execute: vi.fn() } });
    mocks.openRouterCostUsd.mockReturnValue(0.1);
    mocks.generateText.mockResolvedValue({ text: "I could write an article next", steps: [{}], finishReason: "stop", get output() { throw new Error("No output"); } });
    const result = await runHeadlessSamLoop({ ...input("client-example.com"), sourceType: "custom", customPrompt: approved, skillName: null, loopName });
    expect(result.status).toBe("failed");
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
    expect(result.stepsUsed).toBe(1);
    expect(result.costNote).toContain("0.2500");
    expect(result.costNote).toContain("unfinished-step cost unavailable");
    expect(result.error).toContain("Error: Invalid structured result");
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(false);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  describe("generation diagnostics", () => {
    beforeEach(() => {
      mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true, archivedAt: null });
    });

    it.each([404, 401, 402])("records provider HTTP %s without retrying", async (statusCode) => {
      mocks.generateText.mockRejectedValue(Object.assign(new Error("Provider rejected generation"), {
        name: "AI_APICallError", statusCode,
        responseBody: "private response", requestBodyValues: { secret: "private request" },
        cause: new Error("private cause"), stack: "private stack",
      }));
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result).toEqual({
        status: "failed",
        error: `Generation did not return a complete valid result. AI_APICallError (HTTP ${statusCode}): Provider rejected generation`,
        report: "INCOMPLETE — saved progress, not a completed report or verified article. No live improvement is claimed.\n\nFinished model steps: 0.\n\nNo tool results were recorded.\n\nNo written observations were returned before interruption.",
        stepsUsed: 0, proposalsQueued: 0, costNote: "Generation incomplete; final cost unavailable",
      });
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it("records a provider's status property", async () => {
      mocks.generateText.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.error).toBe("Generation did not return a complete valid result. Error (HTTP 401): Unauthorized");
    });

    it("falls back to a valid status when statusCode is invalid", async () => {
      mocks.generateText.mockRejectedValue(Object.assign(new Error("Unauthorized"), { statusCode: 700, status: 401 }));
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.error).toBe("Generation did not return a complete valid result. Error (HTTP 401): Unauthorized");
    });

    it("preserves an AI SDK error name in generation diagnostics", async () => {
      mocks.generateText.mockRejectedValue(Object.assign(new Error("No object generated"), { name: "AI_NoObjectGeneratedError" }));
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.status).toBe("failed");
      expect(result.error).toBe("Generation did not return a complete valid result. AI_NoObjectGeneratedError: No object generated");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it.each(["AI_abcDEF123ghiJKL456mnoPQR789Error", "Bearer_sk-live-abc123"])("keeps secret-shaped error names out of generation diagnostics: %s", async (name) => {
      mocks.generateText.mockRejectedValue(Object.assign(new Error("Provider unavailable"), { name }));
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.status).toBe("failed");
      expect(result.error).toBe("Generation did not return a complete valid result. Error: Provider unavailable");
      expect(JSON.stringify(result)).not.toContain(name);
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it("redacts secret-bearing messages for an allowlisted AI SDK error", async () => {
      mocks.generateText.mockRejectedValue(Object.assign(new Error("No object generated for Bearer sk-live-abc123"), { name: "AI_NoObjectGeneratedError" }));
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.status).toBe("failed");
      expect(result.error).toBe("Generation did not return a complete valid result. AI_NoObjectGeneratedError: No object generated [redacted]");
      expect(JSON.stringify(result)).not.toContain("sk-live-abc123");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it.each([
      { label: "generic Error", failure: new Error("Provider unavailable"), detail: "Error: Provider unavailable" },
      { label: "string", failure: "Provider unavailable", detail: "NonError: Provider unavailable" },
      { label: "null", failure: null, detail: "NonError: Unknown error" },
      { label: "number", failure: 42, detail: "NonError: Unknown error" },
      { label: "object", failure: { name: "UpstreamError", message: "Provider unavailable", statusCode: 502, secret: "private object" }, detail: "UpstreamError (HTTP 502): Provider unavailable" },
    ])("handles a $label throw", async ({ failure, detail }) => {
      mocks.generateText.mockRejectedValue(failure);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.status).toBe("failed");
      expect(result.error).toBe(`Generation did not return a complete valid result. ${detail}`);
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it.each([
      { label: "URL query", message: "Rejected https://provider.example/generate?query-secret=private&email=person@example.test", secrets: ["query-secret", "private", "person@example.test"], dropsPrefix: true },
      { label: "protocol-relative URL query", message: "Rejected //provider.example/generate?customer=private-query", secrets: ["customer=", "private-query"] },
      { label: "relative URL query", message: "Rejected /v1/generate?customer=private-query", secrets: ["customer=", "private-query"] },
      { label: "bearer token", message: "Rejected Bearer bearer-secret.abc+/==", secrets: ["bearer-secret", "abc+/=="], dropsPrefix: true },
      { label: "labeled bearer token", message: "Rejected Bearer token: short-live-secret", secrets: ["short-live-secret"], dropsPrefix: true },
      { label: "quoted bearer token", message: "Rejected bearer \"quoted-bearer-secret\"", secrets: ["quoted-bearer-secret"], dropsPrefix: true },
      { label: "escaped bearer quotes", message: String.raw`Rejected Bearer \"escaped-bearer-secret\"`, secrets: ["escaped-bearer-secret"], dropsPrefix: true },
      { label: "OpenRouter key", message: "Rejected sk-or-v1-provider-secret", secrets: ["sk-or-v1-provider-secret"], dropsPrefix: true },
      { label: "API key assignment", message: "Rejected api_key=assigned-key-secret", secrets: ["assigned-key-secret"], dropsPrefix: true },
      { label: "API key header", message: "Rejected API-Key: \"header key secret\"", secrets: ["header key secret"], dropsPrefix: true },
      { label: "JSON API key", message: 'Rejected {"x-api-key":"json-key-secret"}', secrets: ["json-key-secret"], dropsPrefix: true },
      { label: "escaped JSON API key", message: String.raw`Rejected {\"x-api-key\":\"escaped-key-secret\"}`, secrets: ["escaped-key-secret"], dropsPrefix: true },
      { label: "opaque key", message: `Rejected ${"a1".repeat(20)}`, secrets: ["a1".repeat(20)], dropsPrefix: true },
      { label: "email", message: "Rejected person+tag@example.test", secrets: ["person+tag@example.test"] },
      { label: "email with exclamation mark", message: "Rejected person!@example.test", secrets: ["person", "example.test"] },
      { label: "email with hash", message: "Rejected person#@example.test", secrets: ["person", "example.test"] },
      { label: "email atom symbols", message: "Rejected person!#$%&'*+/=?^_`{|}~@example.test", secrets: ["person", "example.test"] },
      { label: "Unicode email", message: "Rejected josé@example.test", secrets: ["josé", "example.test"] },
      { label: "quoted email", message: 'Rejected "person"@example.test', secrets: ["person", "example.test"] },
      { label: "email with local domain", message: "Rejected person@localhost", secrets: ["person", "localhost"] },
      { label: "email with domain literal", message: "Rejected person@[127.0.0.1]", secrets: ["person", "127.0.0.1"] },
    ].map(testCase => ({ dropsPrefix: true, ...testCase })))("strips $label from a non-Error message", async ({ message, secrets, dropsPrefix }) => {
      mocks.generateText.mockRejectedValue(message);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.status).toBe("failed");
      expect(result.error).toContain("NonError: " + (dropsPrefix ? "[redacted]" : "Rejected"));
      for (const secret of secrets) expect(JSON.stringify(result)).not.toContain(secret);
    });

    it.each([
      { label: "bare labeled bearer", bypass: "Bearer token abc123secret", secrets: ["abc123secret"], dropsPrefix: true },
      { label: "colon bearer", bypass: "Bearer: short-secret", secrets: ["short-secret"], dropsPrefix: true },
      { label: "bracketed bearer", bypass: "Bearer <short-secret>", secrets: ["short-secret"], dropsPrefix: true },
      { label: "multiword quoted bearer", bypass: 'Bearer "quoted secret value"', secrets: ["quoted secret value", "quoted", "value"], dropsPrefix: true },
      { label: "email comment", bypass: "person(comment)@example.com", secrets: ["person", "comment", "example.com"], dropsPrefix: true },
      { label: "URL userinfo", bypass: "https://deploy-token@api.example.com/v1/sites?fields=id,session=supersecret", secrets: ["deploy-token", "fields=id", "supersecret"], dropsPrefix: true },
      { label: "URL path email", bypass: "https://example.com/users/ada@example.com/profile?ids=1,session=supersecret", secrets: ["ada@example.com", "supersecret"], dropsPrefix: true },
      { label: "bare domain query", bypass: "example.com?session=supersecret", secrets: ["supersecret"], dropsPrefix: true },
      { label: "space-separated query", bypass: "https://example.com/path? session=supersecret", secrets: ["supersecret"] },
      { label: "newline-separated query", bypass: "https://example.com/path?\nsession=supersecret", secrets: ["supersecret"] },
      { label: "encoded query delimiter", bypass: "https://example.com/path%3Fsession=supersecret", secrets: ["supersecret"], dropsPrefix: true },
      { label: "client secret", bypass: "client_secret=shortsecret", secrets: ["shortsecret"], dropsPrefix: true },
      { label: "refresh token", bypass: "refresh_token=shortsecret", secrets: ["shortsecret"], dropsPrefix: true },
      { label: "id token", bypass: "id_token=shortsecret", secrets: ["shortsecret"], dropsPrefix: true },
      { label: "API secret", bypass: "api_secret=shortsecret", secrets: ["shortsecret"], dropsPrefix: true },
      { label: "double-underscore API key", bypass: "api__key=shortsecret", secrets: ["shortsecret"], dropsPrefix: true },
      { label: "fragment refresh token", bypass: "https://example.com/cb#refresh_token=shortsecret", secrets: ["shortsecret"], dropsPrefix: true },
      { label: "short plus-delimited key", bypass: "sk-abc+shortSecret", secrets: ["sk-abc+shortSecret", "shortSecret"], dropsPrefix: true },
      { label: "short-signature JWT", bypass: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.shortsig", secrets: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "shortsig"], dropsPrefix: true },
    ].map(testCase => ({ dropsPrefix: false, ...testCase })).flatMap(testCase => ["Rejected ", ""].map(prefix => ({ ...testCase, prefix }))))("fails closed for $label with prefix '$prefix'", async ({ bypass, secrets, prefix, dropsPrefix }) => {
      mocks.generateText.mockRejectedValue(prefix + bypass);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.status).toBe("failed");
      expect(result.error).toContain("NonError: " + (dropsPrefix ? "[redacted]" : prefix));
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
      for (const secret of secrets) expect(JSON.stringify(result)).not.toContain(secret);
    });

    it.each([
      { label: "query then space", bypass: "https://example.com/path? hunter2", secret: "hunter2" },
      { label: "query then newline", bypass: "https://example.com/path?\nhunter2", secret: "hunter2" },
      { label: "query then tab", bypass: "https://example.com/path?\thunter2", secret: "hunter2" },
      { label: "encoded query then space", bypass: "https://example.com/path%3F hunter2", secret: "hunter2" },
      { label: "fragment then space", bypass: "https://example.com/cb# hunter2", secret: "hunter2" },
      { label: "ampersand then space", bypass: "https://example.com/path& hunter2", secret: "hunter2" },
      { label: "split URL userinfo", bypass: "https://deploy:s3cret @api.example.com/v1", secret: "s3cret" },
      { label: "split GitHub URL userinfo", bypass: "https://ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA @github.com/x", secret: "AAAAAAAAAA" },
      { label: "embedded JWT", bypass: "x.eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", secret: "eyJzdWIi" },
      { label: "colon-delimited hex", bypass: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99", secret: ":ee:" },
      { label: "long dotted opaque word", bypass: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.x", secret: "AAAAAAAAAAAAAAAA" },
      { label: "secret within credential label", bypass: "passwordHunterTwo", secret: "HunterTwo" },
      { label: "NBSP within label", bypass: "pass\u00a0word hunter2", secret: "hunter2" },
      { label: "BOM within label", bypass: "pass\uFEFFword hunter2", secret: "hunter2" },
      { label: "Cyrillic look-alike within label", bypass: "p\u0430ssword hunter2", secret: "hunter2" },
      { label: "passphrase", bypass: "passphrase hunter2", secret: "hunter2" },
      { label: "pwd", bypass: "pwd hunter2", secret: "hunter2" },
      { label: "zero-width label separator", bypass: "pass\u200bword hunter2", secret: "hunter2" },
      { label: "API keys with punctuation", bypass: "api keys: hunter2", secret: "hunter2" },
      { label: "URL port", bypass: "https://example.com:8443 hunter2", secret: "hunter2" },
      { label: "bare colon", bypass: ": hunter2", secret: "hunter2" },
      { label: "long URL path segment", bypass: "https://x.example/" + "a".repeat(32) + " hunter2", secret: "hunter2" },
      { label: "long model-id segment", bypass: "provider/" + "a".repeat(32) + " hunter2", secret: "hunter2" },
      { label: "short GitHub personal key", bypass: "ghp_abcd hunter2", secret: "hunter2" },
      { label: "short GitHub OAuth key", bypass: "gho_abcd hunter2", secret: "hunter2" },
      { label: "short Slack key", bypass: "xoxb-abcd hunter2", secret: "hunter2" },
      { label: "short AWS key", bypass: "AKIAabcd hunter2", secret: "hunter2" },
    ].flatMap(testCase => ["Rejected ", ""].map(prefix => ({ ...testCase, prefix }))))(
      "stops at $label with prefix '$prefix'", async ({ bypass, secret, prefix }) => {
        mocks.generateText.mockRejectedValue(prefix + bypass);
        const result = await runHeadlessSamLoop(input("example.com"));
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(result.status).toBe("failed");
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["Error", "NonError"])("replaces a credential-bearing %s name", async (name) => {
      const failure = Object.assign(name === "Error" ? new Error("ok") : { message: "ok" }, {
        name: "passwordHunterTwo", statusCode: 502,
      });
      mocks.generateText.mockRejectedValue(failure);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(JSON.stringify(result)).not.toContain("HunterTwo");
      expect(result.error).toBe("Generation did not return a complete valid result. " + name + " (HTTP 502): ok");
      expect(result.status).toBe("failed");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it.each([
      { label: "AWS key in a URL path", failure: "upstream https://cdn.example.com/AKIAIOSFODNN7EXAMPLE failed", secret: "AKIAIOSFODNN7", detail: "NonError: [redacted]" },
      { label: "Stripe key", failure: "sk_live_51Abcdefghijk", secret: "51Abcdefghijk", detail: "NonError: [redacted]" },
      { label: "temporary AWS key", failure: "ASIAIOSFODNN7EXAMPLE", secret: "ASIAIOSFODNN7", detail: "NonError: [redacted]" },
      { label: "split Stripe URL userinfo", failure: "https://sk_live_51Abcdefghijk @api.example.com", secret: "51Abcdefghijk", detail: "NonError: [redacted]" },
      { label: "one word before a label", failure: "rejected hunter2 password", secret: "hunter2", detail: "NonError: rejected [redacted]" },
      { label: "leetspeak password", failure: "p4ssw0rd hunter2", secret: "hunter2", detail: "NonError: [redacted]" },
      { label: "leetspeak secret", failure: "s3cret hunter2", secret: "hunter2", detail: "NonError: [redacted]" },
      { label: "Google API key", failure: "key AIzaSyA1234567890abcdefgh", secret: "AIzaSy", detail: "NonError: [redacted]" },
      { label: "Slack key", failure: "use xoxb-123-456-abc", secret: "xoxb", detail: "NonError: [redacted]" },
      { label: "GitHub installation key", failure: "ghs_16C7e42F292c6912E7710c838347Ae178B4a", secret: "16C7e42F", detail: "NonError: [redacted]" },
      { label: "three slash-separated mixed runs", failure: "aBcDeF12/gHiJkL34/mNoPqR56", secret: "aBcDeF12", detail: "NonError: [redacted]" },
      { label: "two mixed runs after a path prefix", failure: "x/aBcDeF12/gHiJkL34", secret: "gHiJkL34", detail: "NonError: [redacted]" },
      { label: "two mixed runs in a URL path", failure: "https://h.example/aBcDeF12/gHiJkL34", secret: "aBcDeF12", detail: "NonError: [redacted]" },
      { label: "two six-character mixed path runs", failure: "provider/abcd12/efgh34", secret: "efgh34", detail: "NonError: [redacted]" },
      { label: "embedded leetspeak key", failure: "zz-k3y-Ab12cd34Ef", secret: "Ab12cd34Ef", detail: "NonError: [redacted]" },
      { label: "uppercase embedded leetspeak key", failure: "zz-K3Y-hunter2", secret: "hunter2", detail: "NonError: [redacted]" },
      { label: "embedded leetspeak keys", failure: "my_k3ys_abc", secret: "abc", detail: "NonError: [redacted]" },
      { label: "prefixed embedded leetspeak key", failure: "zz-signingk3y-abc", secret: "abc", detail: "NonError: [redacted]" },
      { label: "secret-shaped Error name", failure: Object.assign(new Error("ok"), { name: "sk_live_51Abcdefghijk" }), secret: "51Abcdefghijk", detail: "Error: ok" },
      { label: "secret-shaped NonError name", failure: { name: "sk_live_51Abcdefghijk", message: "ok" }, secret: "51Abcdefghijk", detail: "NonError: ok" },
    ])("redacts $label in the complete result", async ({ failure, secret, detail }) => {
      mocks.generateText.mockRejectedValue(failure);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.error).toBe("Generation did not return a complete valid result. " + detail);
      expect(result.status).toBe("failed");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it.each([
      "prefixAKIAsuffix", "prefixASIAsuffix", "prefixAIzasuffix", "prefixeyJsuffix",
      "prefix_sk_live_abcd", "prefix_sk_test_abcd", "prefix_sk-or-v1-abcd", "prefix_pk_abcd", "prefix_rk_abcd",
      "prefix_ghp_abcd", "prefix_gho_abcd", "prefix_ghs_abcd", "prefix_ghu_abcd", "prefix_github_pat_abcd",
      "prefix_xoxb-abcd", "prefix_glpat-abcd", "prefix_npm_abcd", "prefix_shpat_abcd", "prefix_whsec_abcd",
      "ghp.abcdefghijk", "xoxb~abcdefghi1",
      "AKIA", "pk~live~abcdef", "a.ghs.b", "whsec.abcd", "xoxp.abc",
      "glpat~abc", "npm.abc", "github_pat.abc",
      "abcdefghijk1", "abcdefghijklmnopqrstuvwx", "123456789012345678901234",
    ].map(secret => ({ secret, detail: "rejected [redacted]" })).concat([
      { secret: "sk.abc+abcd1234", detail: "[redacted]" },
      { secret: "sk+abc", detail: "[redacted]" },
      { secret: "shpat+abc", detail: "[redacted]" },
    ]).flatMap(({ secret, detail }) => [secret, "https://cdn.example.com/" + secret].map(value => ({ secret, value, detail }))))(
      "drops the preceding word for a secret shape in $value", async ({ secret, value, detail }) => {
        mocks.generateText.mockRejectedValue(`rejected prior ${value} failed`);
        const result = await runHeadlessSamLoop(input("example.com"));
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain("prior");
        expect(result.error).toBe("Generation did not return a complete valid result. NonError: " + detail);
      },
    );

    it.each([
      [".", "rejected [redacted]"], ["_", "rejected [redacted]"], ["~", "rejected [redacted]"],
      ["+", "[redacted]"], ["-", "rejected [redacted]"],
    ])("finds a mixed run within a %s-separated path segment", async (separator, detail) => {
      mocks.generateText.mockRejectedValue(`rejected prior provider/part${separator}abcdefghijk1${separator}tail failed`);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(JSON.stringify(result)).not.toContain("abcdefghijk1");
      expect(result.error).toBe("Generation did not return a complete valid result. NonError: " + detail);
    });

    it.each([
      { message: "note hunter2\u00a0password", secret: "hunter2", detail: "[redacted]" },
      { message: "note hunter2\u200bpassword", secret: "hunter2", detail: "[redacted]" },
      { message: "note hunter2\fpassword", secret: "hunter2", detail: "[redacted]" },
      { message: "note hunter2 p\u0430ssword", secret: "hunter2", detail: "[redacted]" },
      { message: "notify hunter2\uff20example.com", secret: "hunter2", detail: "[redacted]" },
      { message: "connect https://api.example.com hunter2 @api.example.com", secret: "hunter2", detail: "connect [redacted]" },
      { message: "connect https://user: hunter2 @api.example.com/v1", secret: "hunter2", detail: "connect [redacted]" },
      { message: "mailbox hunter2 @example.com", secret: "hunter2", detail: "[redacted]" },
      { message: "note hunter2 p@ssw0rd", secret: "hunter2", detail: "[redacted]" },
      { message: "rejected x-key-hunter2 today", secret: "hunter2", detail: "[redacted]" },
      { message: "rejected key_op_123456 today", secret: "123456", detail: "[redacted]" },
      { message: "rejected access_key_hunter2 today", secret: "hunter2", detail: "[redacted]" },
      { message: "rejected abcd1234_abcd5678_efgh90 today", secret: "abcd1234", detail: "[redacted]" },
      { message: "GET https://cdn.example.com/v1/abcd1234+abcd1234+abcd12", secret: "abcd1234", detail: "[redacted]" },
      { message: "note hunter2\vpassword", secret: "hunter2", detail: "[redacted]" },
      { message: "connect prior hunter2 =value", secret: "hunter2", detail: "connect [redacted]" },
      { message: "note hunter2 prior token@example.com", secret: "hunter2", detail: "note [redacted]" },
      { message: "note hunter2 password later\u00a0", secret: "hunter2", detail: "note [redacted]" },
      { message: "GET /path? hunter2\u00a0password", secret: "hunter2", detail: "GET /path [redacted]" },
      { message: "rejected hunter2 api.key.v2 today", secret: "hunter2", detail: "rejected [redacted]" },
      { message: "rejected x-keys-hunter2 today", secret: "hunter2", detail: "[redacted]" },
    ])("redacts the complete result for $message", async ({ message, secret, detail }) => {
      mocks.generateText.mockRejectedValue(message);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.error).toBe("Generation did not return a complete valid result. NonError: " + detail);
      expect(result.status).toBe("failed");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it.each([
      { message: "connect prior hunter2 &equals value", secrets: ["hunter2", "prior"], detail: "connect [redacted]" },
      { message: "connect prior hunter2 &EQUALS value", secrets: ["hunter2", "prior"], detail: "connect [redacted]" },
      { message: "connect prior hunter2 &equals", secrets: ["hunter2", "prior"], detail: "connect [redacted]" },
      { message: "connect prior hunter2 & madeup", secrets: ["hunter2", "prior"], detail: "connect [redacted]" },
      { message: "mailbox hunter2 &commat example.com", secrets: ["hunter2", "example.com"], detail: "[redacted]" },
      { message: "mailbox hunter2 &CoMmAt example.com", secrets: ["hunter2", "example.com"], detail: "[redacted]" },
      { message: "mailbox hunter2 &commat;example.com", secrets: ["hunter2", "example.com"], detail: "[redacted]" },
      { message: "mailbox hunter2 arbitrary&example.com", secrets: ["hunter2", "example.com"], detail: "[redacted]" },
      { message: "connect prior hunter2 &\nequals;value", secrets: ["hunter2", "prior"], detail: "connect [redacted]" },
      { message: "connect prior hunter2 &\tequals;value", secrets: ["hunter2", "prior"], detail: "connect [redacted]" },
      { message: "connect prior hunter2 & equals;value", secrets: ["hunter2", "prior"], detail: "connect [redacted]" },
      { message: "connect prior hunter2 prefix&\nequals;value", secrets: ["hunter2", "prior"], detail: "connect [redacted]" },
      { message: "hunter2&colon;zzzz", secrets: ["hunter2", "zzzz"], detail: "[redacted]" },
      { message: "hunter2&sol;zzzz", secrets: ["hunter2", "zzzz"], detail: "[redacted]" },
      { message: "hunter2&bogus;zzzz", secrets: ["hunter2", "zzzz"], detail: "[redacted]" },
      { message: "hunter2&", secrets: ["hunter2"], detail: "[redacted]" },
      { message: "note hunter2 pa$$word", secrets: ["hunter2", "pa$$word"], detail: "[redacted]" },
      { message: "note hunter2 pa!word", secrets: ["hunter2", "pa!word"], detail: "[redacted]" },
      { message: "note hunter2 pa*word", secrets: ["hunter2", "pa*word"], detail: "[redacted]" },
      { message: "note hunter2 pa^word", secrets: ["hunter2", "pa^word"], detail: "[redacted]" },
      { message: "connect https://hunter2: aabb \uff20api.example.com/v1", secrets: ["hunter2", "aabb", "api.example.com"], detail: "connect [redacted]" },
      { message: "connect https://hunter2:\taabb\t\uff20api.example.com/v1", secrets: ["hunter2", "aabb", "api.example.com"], detail: "connect [redacted]" },
      { message: "connect https://hunter2: aabb \u200bapi.example.com/v1", secrets: ["hunter2", "aabb", "api.example.com"], detail: "connect [redacted]" },
      { message: "connect https://hunter2: aabb \u00a0api.example.com/v1", secrets: ["hunter2", "aabb", "api.example.com"], detail: "connect [redacted]" },
    ])("redacts Round 9 delimiters in $message", async ({ message, secrets, detail }) => {
      mocks.generateText.mockRejectedValue(message);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.error).toBe("Generation did not return a complete valid result. NonError: " + detail);
      for (const secret of secrets) expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.status).toBe("failed");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it.each([
      { message: "rejected zz-signingkeys-abc today", secrets: ["abc"], detail: "[redacted]" },
      { message: "rejected zz-signingkeys-hunter2 today", secrets: ["hunter2"], detail: "[redacted]" },
      { message: "rejected zz-SIGNINGKEYS-abc today", secrets: ["abc"], detail: "[redacted]" },
      { message: "rejected zz-signingkeysid-abc today", secrets: ["abc"], detail: "[redacted]" },
      { message: "note hunter2 appkeys", secrets: ["hunter2"], detail: "note [redacted]" },
      { message: "note hunter2 appKEYS", secrets: ["hunter2"], detail: "note [redacted]" },
      { message: "note hunter2 appk3ys", secrets: ["hunter2"], detail: "note [redacted]" },
      { message: "note hunter2 x-apikeys", secrets: ["hunter2"], detail: "note [redacted]" },
      { message: "note hunter2 mykeys", secrets: ["hunter2"], detail: "note [redacted]" },
      { message: "note hunter2 mykeysid", secrets: ["hunter2"], detail: "note [redacted]" },
      { message: "note hunter2 myKEYS", secrets: ["hunter2"], detail: "note [redacted]" },
      { message: "note hunter2 myk3ys", secrets: ["hunter2"], detail: "note [redacted]" },
      { message: "note hunter2 safek3ys", secrets: ["hunter2"], detail: "note [redacted]" },
      { message: "note hunter2 safekeys", secrets: ["hunter2"], detail: "note [redacted]" },
      { message: "note hunter2 safek3ysuffix", secrets: ["hunter2"], detail: "note [redacted]" },
      { message: "note hunter2 safeK3YS", secrets: ["hunter2"], detail: "note [redacted]" },
      { message: "sshkeys hunter2", secrets: ["hunter2"], detail: "[redacted]" },
      { message: "sshk3ys hunter2", secrets: ["hunter2"], detail: "[redacted]" },
      { message: "SSHKEYS hunter2", secrets: ["hunter2"], detail: "[redacted]" },
      { message: "sshkeysid hunter2", secrets: ["hunter2"], detail: "[redacted]" },
      { message: "zz-signingk3ys-abc", secrets: ["abc"], detail: "[redacted]" },
      { message: "zz-SIGNINGK3YS-abc", secrets: ["abc"], detail: "[redacted]" },
      { message: "zz-signingk3ysid-abc", secrets: ["abc"], detail: "[redacted]" },
      { message: "zz-signingk3y5-hunter2", secrets: ["hunter2"], detail: "[redacted]" },
      { message: "seen hunter2+AEA-example.com", secrets: ["hunter2", "example.com"], detail: "[redacted]" },
      { message: "seen hunter2+ACA-x", secrets: ["hunter2"], detail: "[redacted]" },
      { message: "note hunter2 +AEA-example.com", secrets: ["hunter2", "example.com"], detail: "[redacted]" },
      { message: "connect prior hunter2 +aEa-example.com", secrets: ["prior", "hunter2", "example.com"], detail: "connect [redacted]" },
      { message: "note hunter2 prior+suffix", secrets: ["hunter2", "prior"], detail: "[redacted]" },
      { message: "connect prior hunter2 +A-", secrets: ["prior", "hunter2"], detail: "connect [redacted]" },
      { message: "note hunter2 %u0040x.co", secrets: ["hunter2", "x.co"], detail: "[redacted]" },
      { message: "note hunter2 %U0040x.co", secrets: ["hunter2", "x.co"], detail: "[redacted]" },
      { message: "connect prior hunter2 %u003dx", secrets: ["prior", "hunter2"], detail: "connect [redacted]" },
      { message: "note hunter2 %u", secrets: ["hunter2"], detail: "[redacted]" },
      { message: "note hunter2 %U0", secrets: ["hunter2"], detail: "[redacted]" },
      { message: "note hunter2 path%unothex", secrets: ["hunter2"], detail: "[redacted]" },
    ])("redacts Round 10 labels and escapes in $message", async ({ message, secrets, detail }) => {
      mocks.generateText.mockRejectedValue(message);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.error).toBe("Generation did not return a complete valid result. NonError: " + detail);
      for (const secret of secrets) expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.status).toBe("failed");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it.each([
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEqqq",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEYx",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEYxy",
      "https://cdn.example.com/wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEqqq",
    ])("redacts an AWS-style sample without terminal KEY: %s", async secret => {
      // These samples must exercise shape detection without a terminal key label.
      expect(secret).not.toMatch(/key$/i);
      mocks.generateText.mockRejectedValue(secret);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.error).toBe("Generation did not return a complete valid result. NonError: [redacted]");
      for (const part of ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLE"]) expect(JSON.stringify(result)).not.toContain(part);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.status).toBe("failed");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it.each(["pa$$word", "pa$sw0rd", "$ecret", "se$$ion"])("folds dollar signs in a credential-bearing name: %s", async name => {
      mocks.generateText.mockRejectedValue(Object.assign(new Error("ok"), { name }));
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.error).toBe("Generation did not return a complete valid result. Error: ok");
      expect(JSON.stringify(result)).not.toContain(name);
    });

    it.each([
      "aBcdefGH/iJklmnOP",
      "aBcdefGH/abcd12",
      "https://h.example/aBcdefGH/iJklmnOP",
      "aBcDefffffff",
      "aBcDeFghijkl",
      "provider/aBcDefffffff/tail",
    ])("redacts random-looking runs across the whole word: %s", async secret => {
      mocks.generateText.mockRejectedValue(`rejected prior ${secret} failed`);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.error).toBe("Generation did not return a complete valid result. NonError: rejected [redacted]");
      for (const value of [secret, "prior"]) expect(JSON.stringify(result)).not.toContain(value);
    });

    it.each([
      { message: "connect prior hunter2 %3Dvalue", secret: "hunter2", detail: "connect [redacted]" },
      { message: "mailbox hunter2 %40example.com", secret: "hunter2", detail: "[redacted]" },
      { message: "https://hunter2 %40api.example.com/v1", secret: "hunter2", detail: "[redacted]" },
      { message: "person&#64;example.com", secret: "person", detail: "[redacted]" },
      { message: "ada.lovelace&#64;example.com", secret: "ada.lovelace", detail: "[redacted]" },
      { message: "connect prior hunter2 &#61;value", secret: "hunter2", detail: "connect [redacted]" },
      { message: "a&#x40;b.example", secret: "a", detail: "[redacted]" },
      { message: "x&commat;y.example", secret: "x", detail: "[redacted]" },
      { message: "connect prior hunter2 %3dvalue", secret: "hunter2", detail: "connect [redacted]" },
      { message: "connect prior hunter2 %26value", secret: "hunter2", detail: "connect [redacted]" },
      { message: "connect prior hunter2 %20value", secret: "hunter2", detail: "connect [redacted]" },
      { message: "connect prior hunter2 &#x3d;value", secret: "hunter2", detail: "connect [redacted]" },
      { message: "mailbox hunter2 &#X40;example.com", secret: "hunter2", detail: "[redacted]" },
      { message: "mailbox hunter2 &#64", secret: "hunter2", detail: "[redacted]" },
      { message: "connect prior hunter2 &equals;value", secret: "hunter2", detail: "connect [redacted]" },
      { message: "connect prior hunter2 &amp;value", secret: "hunter2", detail: "connect [redacted]" },
      { message: "connect prior hunter2 &amp;", secret: "hunter2", detail: "connect [redacted]" },
      { message: "connect prior hunter2 &num;value", secret: "hunter2", detail: "connect [redacted]" },
      { message: "connect prior hunter2 &quest;value", secret: "hunter2", detail: "connect [redacted]" },
      { message: "connect prior hunter2 &#63;value", secret: "hunter2", detail: "connect [redacted]" },
      { message: "connect prior hunter2 &#x3f;value", secret: "hunter2", detail: "connect [redacted]" },
      { message: "connect prior hunter2 %3F%40value", secret: "hunter2", detail: "connect [redacted]" },
      { message: "connect prior hunter2 &#35;&#64;value", secret: "hunter2", detail: "connect [redacted]" },
    ])("redacts encoded delimiters in $message", async ({ message, secret, detail }) => {
      mocks.generateText.mockRejectedValue(message);
      const result = await runHeadlessSamLoop(input("example.com"));
      const prefix = "Generation did not return a complete valid result. NonError: ";
      expect(result.error).toBe(prefix + detail);
      // Single-letter local-parts must be checked outside the fixed text and marker.
      expect(result.error!.slice(prefix.length).replace("[redacted]", "")).not.toContain(secret);
      if (secret.length > 1) expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(message);
      expect(result.status).toBe("failed");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it.each([
      [".", "rejected [redacted]"], ["_", "rejected [redacted]"], ["~", "rejected [redacted]"],
      ["+", "[redacted]"], ["-", "rejected [redacted]"],
    ])("finds two short mixed runs separated by %s", async (separator, detail) => {
      mocks.generateText.mockRejectedValue(`rejected prior provider/abcd12${separator}efgh34 failed`);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(JSON.stringify(result)).not.toContain("abcd12");
      expect(JSON.stringify(result)).not.toContain("efgh34");
      expect(result.error).toBe("Generation did not return a complete valid result. NonError: " + detail);
      expect(result.status).toBe("failed");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it.each(["@", "=", "&", "$", "!", "*", "^", "(", ")", "{", "}", "[", "]", "<", ">", '"', "'", "\u0060", "|", "\\"])(
      "stops at special character %s", async (character) => {
        mocks.generateText.mockRejectedValue("Rejected prefix" + character + "suffix hunter2");
        const result = await runHeadlessSamLoop(input("example.com"));
        expect(result.error).toBe("Generation did not return a complete valid result. NonError: [redacted]");
        expect(JSON.stringify(result)).not.toContain("hunter2");
        expect(result.status).toBe("failed");
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["@", "=", "&", "$", "!", "*", "^", "(", ")", "{", "}", "[", "]", "<", ">", '"', "'", "\u0060", "|", "\\"])(
      "drops a previous URL before split userinfo special character %s", async character => {
        mocks.generateText.mockRejectedValue(`Rejected https://deploy ${character}api.example.com hunter2`);
        const result = await runHeadlessSamLoop(input("example.com"));
        expect(JSON.stringify(result)).not.toContain("deploy");
        expect(JSON.stringify(result)).not.toContain("api.example.com");
        expect(JSON.stringify(result)).not.toContain("hunter2");
        expect(result.error).toBe("Generation did not return a complete valid result. NonError: [redacted]");
      },
    );

    it("stops before every later hunter2 in 300 seeded word sequences", async () => {
      const lookbackWords = new Set(["Bearer", "token", "key", "p4ssw0rd", "s3cret", "t0ken", "b34r3r", "sk_live_abcd", "prefixAKIAsuffix", "abcdefghijk1"]);
      const alphabet = [...lookbackWords, "hunter2", "?", "#", "&", "@", ":", "=", "/", "https://x.example", "plain", "\u00a0", "", " ", "\t", "\n"];
      const suspiciousWords = new Set([...lookbackWords, "?", "#", "&", "@", ":", "=", "\u00a0"]);
      let seed = 0x5eed;
      const next = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed;
      };
      let allowedSamples = 0;
      let blockedSamples = 0;
      let lookbackSamples = 0;
      for (let sample = 0; sample < 300; sample++) {
        const words = Array.from({ length: 3 + next() % 9 }, () => alphabet[next() % alphabet.length]!);
        const message = words.map((word, index) => (index ? next() % 2 ? " " : "\n" : "") + word).join("");
        const firstSuspicion = words.findIndex(word => suspiciousWords.has(word));
        const keptBeforeSuspicion = (firstSuspicion === -1 ? words : words.slice(0, firstSuspicion)).filter(word => word.trim());
        if (firstSuspicion !== -1) {
          const stopWord = words[firstSuspicion]!;
          const lookback = ["@", "=", "&", "\u00a0"].includes(stopWord) ? 2 : lookbackWords.has(stopWord) ? 1 : 0;
          for (let previous = 0; previous < lookback; previous++) {
            if (keptBeforeSuspicion.pop() === "hunter2") lookbackSamples++;
          }
        }
        const allowedHunters = keptBeforeSuspicion.filter(word => word === "hunter2").length;
        if (allowedHunters > 0) allowedSamples++;
        if (words.some((word, index) => word === "hunter2" && firstSuspicion !== -1 && index > firstSuspicion)) blockedSamples++;
        mocks.generateText.mockClear();
        mocks.generateText.mockRejectedValue(message);
        const result = await runHeadlessSamLoop(input("example.com"));
        const output = JSON.stringify(result);
        if (allowedHunters === 0) expect(output).not.toContain("hunter2");
        expect(output.match(/hunter2/g) ?? []).toHaveLength(allowedHunters);
        expect(result.status).toBe("failed");
        expect(mocks.generateText).toHaveBeenCalledTimes(1);
      }
      expect(allowedSamples).toBeGreaterThan(0);
      expect(blockedSamples).toBeGreaterThan(0);
      expect(lookbackSamples).toBeGreaterThan(0);
    });

    it.each([
      "Bearer", "Basic", "Authorization:", "token", "secret", "password", "passwd", "passphrase", "passcode", "pwd",
      "apikey", "apitoken", "privatekey", "cookie", "credential", "signature", "session", "key", "signing_key", "api key", "api keys", "api keys:",
      "p4ssw0rd", "s3cret", "t0ken", "b34r3r", "ap1t0ken", "pr1v4t3k3y",
      '"x-api-key":"x"', "#refresh_token=x",
    ])("drops the full suffix after credential label %s", async (label) => {
      mocks.generateText.mockRejectedValue(`Rejected ${label} sensitive value after label`);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.error).toBe("Generation did not return a complete valid result. NonError: [redacted]");
      for (const secret of ["sensitive", "value", "after label"]) expect(JSON.stringify(result)).not.toContain(secret);
    });

    it.each([
      ["https://p.example/generate?x=1", "[redacted]"],
      ["example.com?x=1", "[redacted]"],
      ["/path#x=1", "[redacted]"], ["/path&x=1", "[redacted]"],
      ["/path%3Fx=1", "[redacted]"], ["/path%3fx=1", "[redacted]"], ["/path%23x=1", "[redacted]"],
      ["?x=1", "[redacted]"], ["#x=1", "[redacted]"],
      ["/path? x=1", "Rejected /path [redacted]"], ["/path?\nx:1", "Rejected /path [redacted]"],
      ["? x=1", "Rejected [redacted]"], ["# x:1", "Rejected [redacted]"],
      ["https://example.com/path? hunter2", "Rejected https://example.com/path [redacted]"],
      ["path?\nhunter2", "Rejected path [redacted]"], ["path%3F hunter2", "Rejected path [redacted]"],
      ["path%3f hunter2", "Rejected path [redacted]"], ["path%23 hunter2", "Rejected path [redacted]"],
      ["cb# hunter2", "Rejected cb [redacted]"], ["path& hunter2", "[redacted]"],
      ["path&#35; hunter2", "[redacted]"], ["path&#x23; hunter2", "[redacted]"],
    ])("cuts query data in %s", async (message, detail) => {
      mocks.generateText.mockRejectedValue(`Rejected ${message} following`);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.error).toBe(`Generation did not return a complete valid result. NonError: ${detail}`);
      for (const secret of ["x=1", "x:1"]) expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain("following");
      expect(JSON.stringify(result)).not.toContain("hunter2");
    });

    it("emits only one redaction and drops punctuation on the suspicious word", async () => {
      mocks.generateText.mockRejectedValue('Rejected sk-abcd+xyz <private> "private" person@example.test.,;: done');
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.error).toBe("Generation did not return a complete valid result. NonError: [redacted]");
      for (const secret of ["sk-abcd+xyz", "private", "person@example.test"]) expect(JSON.stringify(result)).not.toContain(secret);
    });

    it("drops remaining text after a credential label before truncation", async () => {
      const message = `Rejected https://provider.example/generate?secret=${"query-secret".repeat(30)} Contact person@example.test. Bearer bearer-secret ${"Provider unavailable. ".repeat(30)}`;
      mocks.generateText.mockRejectedValue(new Error(message));
      const result = await runHeadlessSamLoop(input("example.com"));
      const prefix = "Generation did not return a complete valid result. Error: ";
      expect(result.error).toBe(prefix + "[redacted]");
      expect(result.error!.slice(prefix.length)).toHaveLength(10);
      for (const secret of ["query-secret", "person@example.test", "bearer-secret"]) expect(JSON.stringify(result)).not.toContain(secret);
    });

    it.each([
      "Provider unavailable",
      "No endpoints found for anthropic/claude-sonnet-4.5",
      "No endpoints found for anthropic/claude-sonnet-4.5-20250929",
      "Provider returned error",
      "generateText",
      "NetworkError",
      "generateText/NetworkError",
      "aBcdeFG/hIjklMN",
      "aBcDeffffff",
      "aBcdefGHHHHH",
      "hunter2",
      "ordinary hunter2 prose",
      "https://provider.example/generate",
      "anthropic/claude-sonnet-4.5-20250929",
      "gpt-4o-mini rejected the request",
      "anthropic/claude-sonnet-4.5-20250929 unavailable",
      "claude-sonnet-4.5",
      "provider/abcd12_uvwxyz_123456",
      "20250929 claude sonnet abcdefghij1",
      "abcdefghijklmnopqrstuvw",
      "12345678901234567890123",
      "https://provider.example/abcdefghijklmnopqrstuvw",
      "https://provider.example/12345678901234567890123",
      "provider/part_abcdefghij1_tail",
      "Rejected https://provider.example/generate",
      "Provider unavailable.,;:",
      "HTTP 404 at https://p.example/generate /v1/generate",
    ])("preserves readable diagnostics: %s", async (message) => {
      mocks.generateText.mockRejectedValue(new Error(message));
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.error).toBe(`Generation did not return a complete valid result. Error: ${message}`);
    });

    it.each([
      ["pass\u00a0word hunter2", "[redacted]"],
      ["pass\uFEFFword hunter2", "[redacted]"],
      ["p\u0430ssword hunter2", "[redacted]"],
      ["Provider\u200b hunter2", "[redacted]"],
      ["Provider\u0000 hunter2", "[redacted]"],
      ["Bearer\u00a0hunter2", "[redacted]"],
    ])("stops at the first non-ASCII or control character in %s", async (message, detail) => {
      mocks.generateText.mockRejectedValue(message);
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.error).toBe("Generation did not return a complete valid result. NonError: " + detail);
      expect(JSON.stringify(result)).not.toContain("hunter2");
      expect(result.status).toBe("failed");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it("normalizes whitespace and truncates readable messages to 200 characters", async () => {
      const message = `  ${"Provider\n returned\t error. ".repeat(30)}  `;
      mocks.generateText.mockRejectedValue(new Error(message));
      const result = await runHeadlessSamLoop(input("example.com"));
      const prefix = "Generation did not return a complete valid result. Error: ";
      expect(result.error).toBe(prefix + "Provider returned error. ".repeat(30).trim().slice(0, 200));
      expect(result.error!.slice(prefix.length)).toHaveLength(200);
    });

    it.each([
      ["letters", "a".repeat(100_000)],
      ["slashes", "/".repeat(100_000)],
      ["hyphenated letters", "a-".repeat(50_000)],
      ["key prefix", "sk-" + "a".repeat(99_997)],
      ["URL prefixes", "http://".repeat(14_286).slice(0, 100_000)],
      ["email fragments", "x@".repeat(50_000)],
      ["quotes", '"'.repeat(100_000)],
      ["bearer whitespace", "Bearer" + " ".repeat(99_994)],
    ])("bounds work for 100k-character %s", async (_label, message) => {
      mocks.generateText.mockRejectedValue(message);
      const startedAt = performance.now();
      const result = await runHeadlessSamLoop(input("example.com"));
      const elapsedMs = performance.now() - startedAt;
      expect(message).toHaveLength(100_000);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("[redacted]");
      expect(elapsedMs).toBeLessThan(1000);
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    });

    it("does not expose unsafe error names or nonnumeric HTTP status", async () => {
      mocks.generateText.mockRejectedValue(Object.assign(new Error("Provider unavailable"), {
        name: "Bearer name-secret person@example.test", statusCode: "status-secret",
      }));
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.error).toBe("Generation did not return a complete valid result. Error: Provider unavailable");
    });

    it("keeps a failed result and accounting when error metadata is unreadable", async () => {
      mocks.openRouterCostUsd.mockReturnValue(0.25);
      mocks.generateText.mockImplementation(async (options) => {
        await options.onStepFinish({ providerMetadata: {}, toolResults: [{ toolName: "propose_homegrown_otto_fixes", output: { data: { id: "proposal_1" } } }] });
        throw { get name() { throw new Error("private getter detail"); } };
      });
      const result = await runHeadlessSamLoop(input("example.com"));
      expect(result.status).toBe("failed");
      expect(result.error).toBe("Generation did not return a complete valid result. UnknownError: Unreadable error details");
      expect(result.stepsUsed).toBe(1);
      expect(result.proposalsQueued).toBe(1);
      expect(result.costNote).toContain("0.2500");
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("private getter detail");
    });

    it("sanitizes monthly structured-output failures while retaining spend", async () => {
      mocks.openRouterCostUsd.mockReturnValue(0.1);
      mocks.generateText.mockResolvedValue({
        text: "", steps: [{}], finishReason: "stop",
        get output() { throw Object.assign(new Error("Missing output for person@example.test with Bearer output-secret"), { name: "AI_NoObjectGeneratedError", statusCode: 402 }); },
      });
      const result = await runHeadlessSamLoop({ ...input("example.com"), sourceType: "custom", skillName: null, customPrompt: DEFAULT_SAM_LOOP_TEMPLATES.find(t => t.name === "Monthly content")!.customPrompt!, loopName: "Monthly content" });
      expect(result.status).toBe("failed");
      expect(result.error).toBe("The run did not finish a valid structured article result. AI_NoObjectGeneratedError (HTTP 402): Missing [redacted]");
      expect(result.report).toBe(`Monthly article not completed: ${result.error}\n\nINCOMPLETE — saved progress, not a completed report or verified article. No live improvement is claimed.\n\nFinished model steps: 1.\n\nNo tool results were recorded.\n\nNo written observations were returned before interruption.`);
      expect(result.stepsUsed).toBe(1);
      expect(result.costNote).toContain("0.1000");
      expect(await hasVerifiedMonthlyDraft(result.report)).toBe(false);
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
      for (const secret of ["person@example.test", "output-secret"]) expect(JSON.stringify(result)).not.toContain(secret);
    });
  });

  it.each(["missing", "stale", "blank", "read-error"])("blocks unusable crawl inputs before model spending: %s", async (kind) => {
    mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true, archivedAt: null });
    if (kind === "missing") mocks.getLatestAuditForProject.mockResolvedValue(null);
    if (kind === "stale") mocks.getLatestAuditForProject.mockResolvedValue({ id: "old", status: "completed", startedAt: "2020-01-01T00:00:00Z", completedAt: "2020-01-01T01:00:00Z" });
    if (kind === "blank") mocks.getPagesForAudit.mockResolvedValue([{ url: "https://example.com/", statusCode: 200, fetchClass: "ok", wordCount: 0 }]);
    if (kind === "read-error") mocks.getLatestAuditForProject.mockRejectedValue(new Error("private database detail"));
    const result = await runHeadlessSamLoop(input("example.com", true));
    expect(result.status).toBe("failed");
    expect(result.costNote).toBe("no model call");
    expect(result.report).toContain("Current crawl input unavailable");
    expect(JSON.stringify(result)).not.toContain("private database detail");
    expect(mocks.getChatAgentModel).not.toHaveBeenCalled();
    expect(mocks.buildSamMcpTools).not.toHaveBeenCalled();
    expect(mocks.getProjectContext).not.toHaveBeenCalled();
  });

  it("binds tools and crawl evidence to the saved project domain", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true, archivedAt: null });
    await runHeadlessSamLoop(input("stale-caller.example", true));
    expect(mocks.buildSamMcpTools).toHaveBeenCalledWith(authContext, { id: "project_1", domain: "example.com" });
    const system = mocks.generateText.mock.calls[0]![0].system;
    expect(system).toContain("Crawl input checked before this run:");
    expect(system).toContain("2 usable own-site pages");
    expect(system).toContain("not proof of improved rankings");
    expect(system).toContain("250 words");
  });

  it("keeps rank-only reads independent of crawl readiness", async () => {
    mocks.getProjectById.mockResolvedValue({ domain: "example.com", loopsEnabled: true, archivedAt: null });
    mocks.getLatestAuditForProject.mockResolvedValue(null);
    await runHeadlessSamLoop({ ...input("example.com", true), skillName: "rank-slippage" });
    expect(mocks.getLatestAuditForProject).not.toHaveBeenCalled();
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it.each(["site-health","seo-audit","niceseo-pillars","page-growth","ai-visibility"])("requires current page inventory for %s", async skillName => {
    mocks.getProjectById.mockResolvedValue({domain:"example.com",loopsEnabled:true,archivedAt:null});
    mocks.getLatestAuditForProject.mockResolvedValue(null);
    const result=await runHeadlessSamLoop({...input("example.com"),skillName});
    expect(result.status).toBe("failed");
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
  it.each(["get_audit_pages", "get_audit_status", "get_audit_issues", "Activate seo-audit", DEFAULT_SAM_LOOP_TEMPLATES.find(t=>t.name==="On-page priorities")!.customPrompt!])("gates custom audit reader %s", async customPrompt => {
    mocks.getProjectById.mockResolvedValue({domain:"example.com",loopsEnabled:true,archivedAt:null});
    mocks.getLatestAuditForProject.mockResolvedValue(null);
    const result=await runHeadlessSamLoop({...input("example.com"),sourceType:"custom",skillName:null,customPrompt});
    expect(result.status).toBe("failed");
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
  it.each(["Monthly content", "Keyword portfolio"])("does not require crawl data for %s", async name => {
    mocks.getProjectById.mockResolvedValue({domain:"example.com",loopsEnabled:true,archivedAt:null});
    mocks.getLatestAuditForProject.mockResolvedValue(null);
    await runHeadlessSamLoop({...input("example.com"),sourceType:"custom",skillName:null,customPrompt:(DEFAULT_SAM_LOOP_TEMPLATES.find(t=>t.name===name) as {customPrompt?: string}).customPrompt!});
    expect(mocks.getLatestAuditForProject).not.toHaveBeenCalled();
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

});
