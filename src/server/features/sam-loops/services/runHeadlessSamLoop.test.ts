import { beforeEach, describe, expect, it, vi } from "vitest";
import { SAM_LOOP_ALLOWED_DOMAINS } from "@/shared/sam-loops";
import type { ToolAuthContext } from "@/server/mcp/context";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  getChatAgentModel: vi.fn(),
  getProjectContext: vi.fn(),
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
  buildSamSkillSource: vi.fn(),
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

function input(domain: string | null): HeadlessSamLoopInput {
  return {
    project: {
      id: "project_1",
      name: "Client",
      domain,
      locationCode: 2840,
      languageCode: "en",
    },
    authContext,
    sourceType: "skill",
    skillName: "site-health",
    customPrompt: null,
    loopName: "Site health",
  };
}

describe("runHeadlessSamLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns before any model or tool call when the domain is outside the allowlist", async () => {
    const result = await runHeadlessSamLoop(input("client-example.com"));

    expect(result).toEqual({
      report: `Loop not enabled for this domain (client-example.com). Allowed: ${SAM_LOOP_ALLOWED_DOMAINS.join(", ")}. No tools were called.`,
      stepsUsed: 0,
      proposalsQueued: 0,
      costNote: "no model call",
    });
    expect(mocks.getChatAgentModel).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.getProjectContext).not.toHaveBeenCalled();
  });
});
