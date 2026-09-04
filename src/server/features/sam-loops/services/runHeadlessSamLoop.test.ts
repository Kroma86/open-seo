import { beforeEach, describe, expect, it, vi } from "vitest";
import { SAM_LOOP_ALLOWED_DOMAINS } from "@/shared/sam-loops";
import type { ToolAuthContext } from "@/server/mcp/context";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  getChatAgentModel: vi.fn(),
  getProjectContext: vi.fn(),
  getProjectById: vi.fn(),
  loadSkill: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("ai", () => ({
  generateText: mocks.generateText,
  stepCountIs: () => () => false,
}));
vi.mock("@/server/lib/openrouter", () => ({
  getChatAgentModel: mocks.getChatAgentModel,
}));
vi.mock("@/server/lib/chatAgent", () => ({
  openRouterCostUsd: vi.fn(() => 0),
}));
vi.mock("@/server/features/sam/samChatTools", () => ({
  buildSamMcpTools: vi.fn(() => ({})),
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
  report: abortReport(domain),
  stepsUsed: 0,
  proposalsQueued: 0,
  costNote: "no model call",
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
    mocks.generateText.mockResolvedValue({ text: "loop report", steps: [] });
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
    expect(system).toContain(
      "This project passed the loop gate and is allowed to run. Do the loop work for this project's own domain.",
    );
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
});
