import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginAiVisibilityRun } from "./aiVisibilityRunGuards";

const mocks = vi.hoisted(() => ({
  tryCreateRun: vi.fn(),
  getActiveRunForConfig: vi.fn(),
  updateRun: vi.fn(),
  getRunById: vi.fn(),
  reclaimStaleRunsForConfig: vi.fn(),
}));

vi.mock(
  "@/server/features/ai-visibility/repositories/AiVisibilityRepository",
  () => ({ AiVisibilityRepository: mocks }),
);
vi.mock(
  "@/server/features/ai-visibility/services/aiVisibilityReconciler",
  () => ({
    reclaimStaleRunsForConfig: mocks.reclaimStaleRunsForConfig,
  }),
);

describe("beginAiVisibilityRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reclaimStaleRunsForConfig.mockResolvedValue(undefined);
  });

  it("reclaims stale runs before attempting to create a new run", async () => {
    mocks.tryCreateRun.mockResolvedValue(true);

    await beginAiVisibilityRun({
      configId: "config_1",
      projectId: "project_1",
      promptSetVersion: 2,
    });

    expect(mocks.reclaimStaleRunsForConfig).toHaveBeenCalledWith("config_1");
  });

  it("creates a pending run when no active run exists", async () => {
    mocks.tryCreateRun.mockResolvedValue(true);

    const result = await beginAiVisibilityRun({
      configId: "config_1",
      projectId: "project_1",
      promptSetVersion: 2,
    });

    expect(result).toEqual({ ok: true, runId: expect.any(String) });
    expect(mocks.tryCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        configId: "config_1",
        projectId: "project_1",
        promptSetVersion: 2,
      }),
    );
  });

  it("rejects a second in-flight run via the repository guard", async () => {
    mocks.tryCreateRun.mockResolvedValue(false);
    mocks.getActiveRunForConfig.mockResolvedValue({
      id: "run_blocking",
      status: "running",
    });

    await expect(
      beginAiVisibilityRun({
        configId: "config_1",
        projectId: "project_1",
        promptSetVersion: 2,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "already_running",
      blockingRunId: "run_blocking",
    });
  });
});
