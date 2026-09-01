import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiVisibilityManagementService } from "./AiVisibilityManagementService";

const mocks = vi.hoisted(() => ({
  getConfigById: vi.fn(),
  getConfigByProjectBrand: vi.fn(),
  createConfig: vi.fn(),
  updateConfig: vi.fn(),
  bumpPromptSetVersion: vi.fn(),
  addPrompt: vi.fn(),
  removePrompt: vi.fn(),
  togglePrompt: vi.fn(),
  getPromptById: vi.fn(),
  countActivePromptsForConfig: vi.fn(),
  getPromptsForConfig: vi.fn(),
  isHostedServerAuthMode: vi.fn(),
  customerHasPaidPlan: vi.fn(),
}));

vi.mock(
  "@/server/features/ai-visibility/repositories/AiVisibilityRepository",
  () => ({ AiVisibilityRepository: mocks }),
);
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: mocks.isHostedServerAuthMode,
}));
vi.mock("@/server/billing/subscription", () => ({
  customerHasPaidPlan: mocks.customerHasPaidPlan,
}));

const config = {
  id: "config_1",
  projectId: "project_1",
  brand: "Acme",
  competitors: "[]",
  platforms: '["chat_gpt","google"]',
  scheduleInterval: "weekly" as const,
  promptSetVersion: 3,
  isActive: true,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("AiVisibilityManagementService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfigById.mockResolvedValue(config);
    mocks.bumpPromptSetVersion.mockResolvedValue(4);
  });

  it("bumps promptSetVersion when adding a prompt", async () => {
    mocks.countActivePromptsForConfig.mockResolvedValue(2);
    mocks.addPrompt.mockResolvedValue("prompt_1");

    await AiVisibilityManagementService.addPrompt(
      "config_1",
      "project_1",
      "best seo tools",
    );

    expect(mocks.bumpPromptSetVersion).toHaveBeenCalledWith(
      "config_1",
      "project_1",
    );
  });

  it("rejects an 11th active prompt", async () => {
    mocks.countActivePromptsForConfig.mockResolvedValue(10);

    await expect(
      AiVisibilityManagementService.addPrompt(
        "config_1",
        "project_1",
        "eleventh prompt",
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocks.addPrompt).not.toHaveBeenCalled();
  });

  it("rejects activating a prompt when the cap is reached", async () => {
    mocks.getPromptById.mockResolvedValue({
      id: "prompt_1",
      isActive: false,
    });
    mocks.countActivePromptsForConfig.mockResolvedValue(10);
    mocks.togglePrompt.mockResolvedValue("prompt_1");

    await expect(
      AiVisibilityManagementService.togglePrompt(
        "config_1",
        "project_1",
        "prompt_1",
        true,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
