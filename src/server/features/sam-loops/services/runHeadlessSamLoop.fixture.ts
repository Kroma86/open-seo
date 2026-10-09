import { z } from "zod";
import { beforeEach, vi } from "vitest";
import {
  DEFAULT_SAM_LOOP_TEMPLATES,
  SAM_LOOP_ALLOWED_DOMAINS,
} from "@/shared/sam-loops";
import type { ToolAuthContext } from "@/server/mcp/context";

const mocks = vi.hoisted(() => ({
  generateText:
    vi.fn<
      (request: {
        system: string;
        prompt: string;
        tools: Record<string, unknown>;
        output?: unknown;
        onStepFinish: (step: {
          providerMetadata: Record<string, unknown>;
          toolResults: unknown[];
        }) => Promise<void>;
      }) => Promise<unknown>
    >(),
  getChatAgentModel: vi.fn(),
  getProjectContext: vi.fn(),
  getProjectById: vi.fn<
    () => Promise<{
      domain: string;
      loopsEnabled: boolean;
      archivedAt: string | null;
    } | null>
  >(),
  getLatestAuditForProject: vi.fn(),
  getPagesForAudit: vi.fn(),
  loadSkill: vi.fn(),
  buildSamMcpTools: vi.fn(),
  openRouterCostUsd: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("ai", () => ({
  APICallError: { isInstance: () => false },
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

import { type HeadlessSamLoopInput } from "./runHeadlessSamLoop";

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
    id: "audit_current",
    status: "completed",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: new Date(Date.now() - 30_000).toISOString(),
  });
  mocks.getPagesForAudit.mockImplementation(async () => {
    const project = z
      .object({ domain: z.string() })
      .parse(await mocks.getProjectById.mock.results.at(-1)?.value);
    return ["/", "/services"].map((path) => ({
      url: `https://${project?.domain}${path}`,
      statusCode: 200,
      fetchClass: "ok",
      wordCount: 200,
    }));
  });
  mocks.getChatAgentModel.mockResolvedValue({});
  mocks.generateText.mockResolvedValue({ text: "loop report", steps: [] });
  mocks.buildSamMcpTools.mockReturnValue({});
  mocks.openRouterCostUsd.mockReturnValue(0);
});

export function getMocks() {
  return mocks;
}

export function templatePrompt(name: string): string {
  const template = DEFAULT_SAM_LOOP_TEMPLATES.find(
    (entry) => entry.name === name,
  );
  if (!template || !("customPrompt" in template))
    throw new Error("Missing custom loop fixture");
  return template.customPrompt;
}
