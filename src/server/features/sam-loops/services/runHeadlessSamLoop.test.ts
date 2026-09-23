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
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(false);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
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
