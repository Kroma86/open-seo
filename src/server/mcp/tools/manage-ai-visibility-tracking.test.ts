import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  brandMismatchWarning,
  manageAiVisibilityTrackingTool,
} from "./manage-ai-visibility-tracking";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  createConfig: vi.fn(),
  getConfigWithPrompts: vi.fn(),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/ai-visibility/services/AiVisibilityManagementService",
  () => ({
    AiVisibilityManagementService: {
      createConfig: mocks.createConfig,
      getConfigWithPrompts: mocks.getConfigWithPrompts,
    },
  }),
);

const projectId = "11111111-1111-4111-8111-111111111111";

describe("brandMismatchWarning", () => {
  it("is silent when a brand word appears in the domain", () => {
    expect(
      brandMismatchWarning("Vernon Flowers", {
        domain: "vernonflowers.ca",
        name: "Default",
      }),
    ).toBeNull();
  });

  it("is silent when a brand word appears in the project name", () => {
    expect(
      brandMismatchWarning("Oopsie Daisy", {
        domain: "vernonflowers.ca",
        name: "Oopsie Daisy Flowers",
      }),
    ).toBeNull();
  });

  it("warns when no brand word of 4+ letters appears anywhere", () => {
    expect(
      brandMismatchWarning("Toronto Home Care", {
        domain: "homecaresolutions.ca",
        name: "Default",
      }),
    ).toBeNull(); // "home" and "care" do appear
    expect(
      brandMismatchWarning("DreamLog", {
        domain: "daysdream.ca",
        name: "Default",
      }),
    ).toMatch(/^WARNING: brand "DreamLog"/);
  });

  it("never warns for brands with only short words", () => {
    expect(
      brandMismatchWarning("A&W", { domain: "example.com", name: "X" }),
    ).toBeNull();
  });
});

describe("manage_ai_visibility_tracking create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectForOrganization.mockResolvedValue({
      id: projectId,
      name: "Default",
      domain: "vernonflowers.ca",
      locationCode: 2840,
      languageCode: "en",
    });
    mocks.createConfig.mockImplementation(async (input: { brand: string }) => ({
      id: "cfg_1",
      brand: input.brand,
    }));
    mocks.getConfigWithPrompts.mockResolvedValue({
      id: "cfg_1",
      prompts: [],
      promptSetVersion: 1,
    });
  });

  it("appends the mismatch warning when the brand shares no word with the project", async () => {
    const result = await manageAiVisibilityTrackingTool.handler(
      { projectId, action: "create", brand: "DreamLog" },
      makeToolContext(),
    );
    const text = textContent(result);
    expect(text).toContain("Created AI visibility config cfg_1 for DreamLog.");
    expect(text).toContain("WARNING: brand \"DreamLog\"");
  });

  it("stays quiet when the brand matches the domain", async () => {
    const result = await manageAiVisibilityTrackingTool.handler(
      { projectId, action: "create", brand: "Vernon Flowers" },
      makeToolContext(),
    );
    expect(textContent(result)).not.toContain("WARNING");
  });
});
