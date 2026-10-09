import { vi } from "vitest";
import { SAM_LOOP_ALLOWED_DOMAINS } from "@/shared/sam-loops";
import type { ToolAuthContext } from "@/server/mcp/context";
import type { HeadlessSamLoopInput } from "./runHeadlessSamLoop";

// Shared mocks for the runHeadlessSamLoop*.test.ts files. vi.mock only hoists
// within a test file, so each file wires `mockedModules` into its own
// vi.mock factories.

type ProjectRow = {
  domain: string | null;
  loopsEnabled: boolean;
  archivedAt: string | null;
};

// Only the generateText request fields these tests read.
type GenerateTextRequest = {
  system: string;
  prompt: string;
  tools: Record<string, unknown>;
  output?: unknown;
  onStepFinish: (step: {
    providerMetadata: object;
    toolResults: unknown[];
  }) => unknown;
};

export const mocks = {
  generateText: vi.fn<(request: GenerateTextRequest) => Promise<unknown>>(),
  getChatAgentModel: vi.fn(),
  getProjectContext: vi.fn(),
  getProjectById: vi.fn<(projectId: string) => Promise<ProjectRow | null>>(),
  getLatestAuditForProject: vi.fn(),
  getPagesForAudit: vi.fn(),
  loadSkill: vi.fn(),
  buildSamMcpTools: vi.fn(),
  openRouterCostUsd: vi.fn(),
};

export const mockedModules = {
  ai: {
    generateText: mocks.generateText,
    stepCountIs: () => () => false,
    Output: { object: (value: unknown) => value },
  },
  openrouter: { getChatAgentModel: mocks.getChatAgentModel },
  chatAgent: { openRouterCostUsd: mocks.openRouterCostUsd },
  samChatTools: { buildSamMcpTools: mocks.buildSamMcpTools },
  samSkills: { buildSamSkillSource: () => ({ load: mocks.loadSkill }) },
  samSystemPrompt: { buildSamSystemPrompt: vi.fn(() => "") },
  projectContextService: {
    ProjectContextService: {
      getProjectContext: mocks.getProjectContext,
      renderProjectContextMarkdown: vi.fn(() => ""),
    },
  },
  projectRepository: {
    ProjectRepository: { getProjectById: mocks.getProjectById },
  },
  auditRepository: {
    AuditRepository: {
      getLatestAuditForProject: mocks.getLatestAuditForProject,
      getPagesForAudit: mocks.getPagesForAudit,
    },
  },
};

export const authContext: ToolAuthContext = {
  userId: "user_1",
  userEmail: "sam@niceseo.ai",
  organizationId: "org_1",
  scopes: [],
  clientId: null,
  baseUrl: "https://niceseo.ai",
};

export function input(
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

export const abortResult = (domain: string) => ({
  status: "failed",
  error: "Loop is not enabled for this project.",
  report: abortReport(domain),
  stepsUsed: 0,
  proposalsQueued: 0,
  costNote: "no model call",
});

/** The request passed to the first generateText call. */
export function firstGenerateTextRequest(): GenerateTextRequest {
  const request = mocks.generateText.mock.calls[0]?.[0];
  if (!request) throw new Error("generateText was not called");
  return request;
}

export function setDefaultMocks() {
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
    id: "audit_current",
    status: "completed",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: new Date(Date.now() - 30_000).toISOString(),
  });
  mocks.getPagesForAudit.mockImplementation(async () => {
    const last = mocks.getProjectById.mock.results.at(-1);
    if (last?.type !== "return") throw new Error("no project lookup");
    const project = await last.value;
    if (!project) throw new Error("no project row");
    return ["/", "/services"].map((path) => ({
      url: `https://${project.domain}${path}`,
      statusCode: 200,
      fetchClass: "ok",
      wordCount: 200,
    }));
  });
  mocks.getChatAgentModel.mockResolvedValue({});
  mocks.generateText.mockResolvedValue({ text: "loop report", steps: [] });
  mocks.buildSamMcpTools.mockReturnValue({});
  mocks.openRouterCostUsd.mockReturnValue(0);
}
