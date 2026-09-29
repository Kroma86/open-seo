import { beforeEach, describe, expect, it, vi } from "vitest";

type DueConfigRow = {
  id: string;
  projectId: string;
  brand: string;
  competitors: string;
  platforms: string;
  scheduleInterval: "weekly" | "monthly" | "manual";
  promptSetVersion: number;
  nextRunAt: string | null;
  organizationId: string;
};

const mocks = vi.hoisted(() => ({
  getDueConfigsWithOrganization:
    vi.fn<(nowIso: string) => Promise<DueConfigRow[]>>(),
  getActivePromptsForConfig: vi.fn(),
  claimDueConfig: vi.fn(),
  updateConfig: vi.fn(),
  listQueuedManualRuns: vi.fn(),
  getRunById: vi.fn(),
  updateRunIfInFlight: vi.fn(),
  runAiVisibilityCheck: vi.fn(),
  executeQueuedAiVisibilityRun: vi.fn(),
  customerHasPaidPlan: vi.fn(),
  isHostedServerAuthMode: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/ai-visibility/repositories/AiVisibilityRepository",
  () => ({
    AiVisibilityRepository: {
      getDueConfigsWithOrganization: mocks.getDueConfigsWithOrganization,
      getActivePromptsForConfig: mocks.getActivePromptsForConfig,
      claimDueConfig: mocks.claimDueConfig,
      updateConfig: mocks.updateConfig,
      listQueuedManualRuns: mocks.listQueuedManualRuns,
      getRunById: mocks.getRunById,
      updateRunIfInFlight: mocks.updateRunIfInFlight,
    },
  }),
);
vi.mock(
  "@/server/features/ai-visibility/services/aiVisibilityReconciler",
  () => ({
    reconcileStaleAiVisibilityRuns: vi.fn().mockResolvedValue(undefined),
  }),
);
vi.mock(
  "@/server/features/ai-visibility/services/runAiVisibilityCheck",
  () => ({
    runAiVisibilityCheck: mocks.runAiVisibilityCheck,
    executeQueuedAiVisibilityRun: mocks.executeQueuedAiVisibilityRun,
  }),
);
vi.mock("@/server/billing/subscription", () => ({
  customerHasPaidPlan: mocks.customerHasPaidPlan,
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: mocks.isHostedServerAuthMode,
}));

function dueConfig(overrides: Partial<DueConfigRow> = {}): DueConfigRow {
  return {
    id: "config_1",
    projectId: "project_1",
    brand: "Acme",
    competitors: "[]",
    platforms: '["chat_gpt","google"]',
    scheduleInterval: "weekly",
    promptSetVersion: 1,
    nextRunAt: "2026-01-01T00:00:00.000Z",
    organizationId: "org_1",
    ...overrides,
  };
}

async function runTick() {
  const { runScheduledAiVisibilityChecks } =
    await import("./scheduledAiVisibilityChecks");
  await runScheduledAiVisibilityChecks({} as Env);
}

describe("runScheduledAiVisibilityChecks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.isHostedServerAuthMode.mockResolvedValue(true);
    mocks.customerHasPaidPlan.mockResolvedValue(true);
    mocks.claimDueConfig.mockResolvedValue(true);
    mocks.updateConfig.mockResolvedValue(undefined);
    mocks.runAiVisibilityCheck.mockResolvedValue({ ok: true, runId: "run_1" });
    mocks.getActivePromptsForConfig.mockResolvedValue([
      { id: "prompt_1", prompt: "best tools" },
    ]);
    mocks.getDueConfigsWithOrganization.mockResolvedValue([]);
    mocks.listQueuedManualRuns.mockResolvedValue([]);
    mocks.executeQueuedAiVisibilityRun.mockResolvedValue("completed");
    mocks.getRunById.mockResolvedValue({ id: "run_q", status: "pending" });
    mocks.updateRunIfInFlight.mockResolvedValue(true);
  });

  it("makes zero engine calls when nothing is due", async () => {
    await runTick();
    expect(mocks.runAiVisibilityCheck).not.toHaveBeenCalled();
    expect(mocks.claimDueConfig).not.toHaveBeenCalled();
  });

  it("advances configs with no active prompts without running checks", async () => {
    mocks.getDueConfigsWithOrganization.mockResolvedValue([dueConfig()]);
    mocks.getActivePromptsForConfig.mockResolvedValue([]);

    await runTick();

    expect(mocks.claimDueConfig).toHaveBeenCalledTimes(1);
    expect(mocks.runAiVisibilityCheck).not.toHaveBeenCalled();
  });

  it("runs due configs with active prompts", async () => {
    mocks.getDueConfigsWithOrganization.mockResolvedValue([dueConfig()]);

    await runTick();

    expect(mocks.runAiVisibilityCheck).toHaveBeenCalledTimes(1);
    expect(mocks.runAiVisibilityCheck).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "scheduled" }),
    );
  });

  it("backs off nextRunAt by one hour when a scheduled run throws", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T12:00:00.000Z"));
    mocks.getDueConfigsWithOrganization.mockResolvedValue([dueConfig()]);
    mocks.runAiVisibilityCheck.mockRejectedValue(new Error("upstream failed"));

    await runTick();

    // Backoff is a CAS write on the claimed slot, never a blind updateConfig.
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(mocks.claimDueConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        configId: "config_1",
        projectId: "project_1",
        nextRunAt: "2026-02-01T13:00:00.000Z",
      }),
    );
    vi.useRealTimers();
  });

  it("finishes a queued manual run on the scheduled checker without moving the schedule", async () => {
    mocks.listQueuedManualRuns.mockResolvedValue([
      {
        id: "run_q",
        configId: "config_1",
        projectId: "project_1",
        organizationId: "org_1",
      },
    ]);

    await runTick();

    expect(mocks.runAiVisibilityCheck).not.toHaveBeenCalled();
    expect(mocks.claimDueConfig).not.toHaveBeenCalled();
    expect(mocks.executeQueuedAiVisibilityRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run_q",
        configId: "config_1",
        projectId: "project_1",
        billingCustomer: expect.objectContaining({ organizationId: "org_1" }),
      }),
    );
  });

  it("a failed queued run does not leave the row running or shift nextRunAt", async () => {
    mocks.listQueuedManualRuns.mockResolvedValue([
      {
        id: "run_q",
        configId: "config_1",
        projectId: "project_1",
        organizationId: "org_1",
      },
    ]);
    mocks.executeQueuedAiVisibilityRun.mockRejectedValue(
      new Error("upstream failed"),
    );

    await runTick();

    expect(mocks.claimDueConfig).not.toHaveBeenCalled();
    expect(mocks.updateRunIfInFlight).not.toHaveBeenCalledWith(
      "run_q",
      expect.objectContaining({ status: "running" }),
      expect.anything(),
    );
  });

  it("does not start a paid queued run when the plan check says free", async () => {
    mocks.customerHasPaidPlan.mockResolvedValue(false);
    mocks.listQueuedManualRuns.mockResolvedValue([
      {
        id: "run_q",
        configId: "config_1",
        projectId: "project_1",
        organizationId: "org_1",
      },
    ]);

    await runTick();

    expect(mocks.executeQueuedAiVisibilityRun).not.toHaveBeenCalled();
    expect(mocks.updateRunIfInFlight).toHaveBeenCalledWith(
      "run_q",
      expect.objectContaining({ status: "failed" }),
      { requireRunning: false },
    );
  });
});
