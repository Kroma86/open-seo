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
  runAiVisibilityCheck: vi.fn(),
  runQueuedManualAiVisibilityChecks: vi.fn(),
  customerHasPaidPlan: vi.fn(),
  isHostedServerAuthMode: vi.fn(),
}));

vi.mock("./manualAiVisibilityQueue", () => ({
  runQueuedManualAiVisibilityChecks: mocks.runQueuedManualAiVisibilityChecks,
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the scheduler under test never reads env bindings
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
      expect.objectContaining({
        trigger: "scheduled",
        nameBudget: { spentUsd: 0, capUsd: 0.1 },
      }),
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
});

describe("manual queue shares the scheduled tick", () => {
  it("passes one budget object to the manual worker and scheduled engine", async () => {
    mocks.isHostedServerAuthMode.mockResolvedValue(false);
    mocks.getDueConfigsWithOrganization.mockResolvedValue([dueConfig()]);
    mocks.getActivePromptsForConfig.mockResolvedValue([
      { id: "p", prompt: "test" },
    ]);
    mocks.claimDueConfig.mockResolvedValue(true);
    mocks.runAiVisibilityCheck.mockResolvedValue({ ok: true, runId: "r" });
    mocks.runQueuedManualAiVisibilityChecks.mockImplementation(
      async (budget) => {
        budget.spentUsd = 0.001;
      },
    );
    await runTick();
    const budget = mocks.runQueuedManualAiVisibilityChecks.mock.lastCall?.[0];
    expect(mocks.runAiVisibilityCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ nameBudget: budget }),
    );
    expect(budget.spentUsd).toBe(0.001);
  });
  it("a manual queue error does not suppress due scheduled work", async () => {
    mocks.isHostedServerAuthMode.mockResolvedValue(false);
    mocks.getDueConfigsWithOrganization.mockResolvedValue([dueConfig()]);
    mocks.getActivePromptsForConfig.mockResolvedValue([
      { id: "p", prompt: "test" },
    ]);
    mocks.claimDueConfig.mockResolvedValue(true);
    mocks.runAiVisibilityCheck.mockResolvedValue({ ok: true, runId: "r" });
    mocks.runQueuedManualAiVisibilityChecks.mockRejectedValue(
      new Error("queue read unavailable"),
    );
    await runTick();
    expect(mocks.runAiVisibilityCheck).toHaveBeenCalled();
  });
});
