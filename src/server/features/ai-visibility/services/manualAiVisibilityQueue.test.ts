import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueManualAiVisibilityCheck,
  runQueuedManualAiVisibilityChecks,
} from "./manualAiVisibilityQueue";
import {
  aiVisibilityRequestFingerprint,
  MANUAL_AI_QUEUE_PREFIX,
} from "./manualAiVisibilityQueueContract";

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, any>,
  project: {} as Record<string, any>,
  prompts: [] as any[],
  runs: new Map<string, any>(),
  access: vi.fn(),
  lookup: vi.fn(),
  explore: vi.fn(),
  updateConfig: vi.fn(),
  create: vi.fn(),
  claim: vi.fn(),
  failPending: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("./AiVisibilityManagementService", () => ({
  AiVisibilityManagementService: {
    requireAiVisibilityAccess: mocks.access,
    getValidatedConfig: vi.fn(async (configId, projectId) => {
      if (configId !== mocks.config.id || projectId !== mocks.config.projectId)
        throw new Error("config scope");
      return { ...mocks.config };
    }),
  },
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectForOrganization: vi.fn(async (id, org) =>
      id === mocks.project.id &&
      org === mocks.project.organizationId &&
      !mocks.project.archivedAt
        ? { ...mocks.project }
        : null,
    ),
  },
}));
vi.mock("./aiVisibilityReconciler", () => ({
  reclaimStaleRunsForConfig: vi.fn(async () => {}),
}));
vi.mock("@/server/features/ai-search/services/brandLookup", () => ({
  getBrandLookup: mocks.lookup,
}));
vi.mock("@/server/features/ai-search/services/promptExplorer", () => ({
  explorePrompt: mocks.explore,
}));
vi.mock("./jevBrandName", () => ({
  askJevNamed: vi.fn(async () => ({ p: 1, costUsd: 0 })),
}));
vi.mock(
  "@/server/features/ai-visibility/repositories/AiVisibilityRepository",
  () => ({
    AiVisibilityRepository: {
      tryCreateRun: mocks.create,
      updateRunIfInFlight: mocks.claim,
      failPendingRun: mocks.failPending,
      getQueuedManualRuns: vi.fn(async () =>
        [...mocks.runs.values()]
          .filter(
            (r) =>
              r.status === "pending" &&
              r.detail?.startsWith('{"queue":"manual_ai_visibility_v1",'),
          )
          .slice(0, 3)
          .map((r) => ({ ...r })),
      ),
      getActiveRunForConfig: vi.fn(
        async (id) =>
          [...mocks.runs.values()].find(
            (r) =>
              r.configId === id && ["pending", "running"].includes(r.status),
          ) ?? null,
      ),
      getRunById: vi.fn(async (id) => mocks.runs.get(id) ?? null),
      getActivePromptsForConfig: vi.fn(async () =>
        mocks.prompts.map((p) => ({ ...p })),
      ),
      getCompletedRunsForConfig: vi.fn(async () => []),
      updateConfig: mocks.updateConfig,
    },
  }),
);

const input = {
  configId: "config1",
  projectId: "project1",
  billingCustomer: {
    userId: "user1",
    userEmail: "operator@example.test",
    organizationId: "org1",
    projectId: "project1",
  },
};
const budget = () => ({ spentUsd: 0, capUsd: 0.03 });
const lookupResult = {
  query: "Acme",
  resolvedTarget: "example.test",
  fetchedAt: "2026-10-15T00:00:00Z",
  hasData: true,
  perPlatform: [{ platform: "google", mentions: 1, impressions: null }],
  topPages: [],
  shareOfVoice: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runs.clear();
  mocks.config = {
    id: "config1",
    projectId: "project1",
    brand: "Acme",
    competitors: "[]",
    platforms: '["chat_gpt"]',
    promptSetVersion: 1,
    isActive: true,
    scheduleInterval: "manual",
  };
  mocks.project = {
    id: "project1",
    organizationId: "org1",
    domain: "example.test",
    locationCode: 2124,
    languageCode: "en",
    archivedAt: null,
  };
  mocks.prompts = [
    { id: "prompt1", prompt: "best local service", isActive: true },
  ];
  mocks.access.mockResolvedValue(undefined);
  mocks.lookup.mockResolvedValue(lookupResult);
  mocks.explore.mockResolvedValue({
    prompt: "best local service",
    highlightBrand: "Acme",
    fetchedAt: "2026-10-15T00:00:00Z",
    results: [
      {
        status: "success",
        model: "chat_gpt",
        modelName: "gpt",
        text: "Acme is a local service.",
        brandMentioned: true,
        citations: [],
      },
    ],
  });
  mocks.create.mockImplementation(async (data) => {
    if (
      [...mocks.runs.values()].some(
        (r) =>
          r.configId === data.configId &&
          ["pending", "running"].includes(r.status),
      )
    )
      return false;
    mocks.runs.set(data.id, {
      ...data,
      status: "pending",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    });
    return true;
  });
  mocks.claim.mockImplementation(async (id, data, options) => {
    const r = mocks.runs.get(id);
    if (!r) return false;
    const allowed = options.requirePending
      ? r.status === "pending"
      : options.requireRunning
        ? r.status === "running"
        : ["pending", "running"].includes(r.status);
    if (!allowed) return false;
    Object.assign(r, data);
    return true;
  });
  mocks.failPending.mockImplementation(async (id, error) => {
    const r = mocks.runs.get(id);
    if (r?.status !== "pending") return false;
    Object.assign(r, {
      status: "failed",
      error,
      finishedAt: new Date().toISOString(),
    });
    return true;
  });
});

afterEach(() => vi.useRealTimers());

async function queued() {
  const result = await enqueueManualAiVisibilityCheck(input);
  expect(result.ok).toBe(true);
  return mocks.runs.get((result as { runId: string }).runId);
}

describe("durable manual AI checks", () => {
  it("returns queued with no provider work, then the cron completes the same run after the request is gone", async () => {
    const row = await queued();
    expect(row.status).toBe("pending");
    expect(row.detail.startsWith(MANUAL_AI_QUEUE_PREFIX)).toBe(true);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.explore).not.toHaveBeenCalled();
    await runQueuedManualAiVisibilityChecks(budget());
    expect(mocks.runs.size).toBe(1);
    expect(row.status).toBe("completed");
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.explore).toHaveBeenCalledTimes(1);
    expect(mocks.updateConfig).toHaveBeenCalledWith("config1", "project1", {
      lastRunAt: expect.any(String),
    });
  });
  it("one enqueue wins when two requests overlap", async () => {
    const r = await Promise.all([
      enqueueManualAiVisibilityCheck(input),
      enqueueManualAiVisibilityCheck(input),
    ]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(mocks.runs.size).toBe(1);
    expect(r.find((x) => !x.ok)).toMatchObject({
      blockingRunId: [...mocks.runs.keys()][0],
    });
  });
  it.each(["pending", "running"])(
    "preserves a legacy/scheduled %s blocker",
    async (status) => {
      mocks.runs.set("legacy", {
        id: "legacy",
        configId: "config1",
        projectId: "project1",
        status,
        detail: null,
      });
      expect(await enqueueManualAiVisibilityCheck(input)).toMatchObject({
        ok: false,
        blockingRunId: "legacy",
      });
      await runQueuedManualAiVisibilityChecks(budget());
      expect(mocks.lookup).not.toHaveBeenCalled();
      expect(mocks.runs.get("legacy").status).toBe(status);
    },
  );
  it("only one consumer can spend, and the loser cannot fail the running row", async () => {
    const row = await queued();
    let release!: (v: typeof lookupResult) => void;
    mocks.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const a = runQueuedManualAiVisibilityChecks(budget()),
      b = runQueuedManualAiVisibilityChecks(budget());
    await vi.waitFor(() => expect(mocks.lookup).toHaveBeenCalledTimes(1));
    expect(row.status).toBe("running");
    release(lookupResult);
    await Promise.all([a, b]);
    expect(row.status).toBe("completed");
    expect(mocks.explore).toHaveBeenCalledTimes(1);
    await runQueuedManualAiVisibilityChecks(budget());
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it.each([
    "configId",
    "projectId",
    "brand",
    "competitors",
    "platforms",
    "promptSetVersion",
    "scheduleInterval",
    "isActive",
    "domain",
    "locationCode",
    "languageCode",
    "prompts",
  ])("rejects changed %s before lookup", async (field) => {
    const row = await queued();
    if (field === "configId") mocks.config.id = "changed";
    else if (field === "projectId") mocks.config.projectId = "changed";
    else if (field === "prompts") mocks.prompts[0].prompt = "changed";
    else if (field in mocks.project)
      mocks.project[field] = field === "locationCode" ? 2840 : "changed";
    else
      mocks.config[field] =
        field === "isActive"
          ? false
          : field === "promptSetVersion"
            ? 2
            : "changed";
    await runQueuedManualAiVisibilityChecks(budget());
    expect(row.status).toBe("failed");
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.explore).not.toHaveBeenCalled();
  });
  it.each([
    "archive",
    "foreign-org",
    "malformed",
    "scope",
    "expired",
    "future",
    "invalid-date",
    "no-prompts",
    "plan-denied",
    "row-version",
    "row-config",
    "row-project",
  ])("fails closed on %s without replay", async (mode) => {
    const row = await queued();
    if (mode === "archive") mocks.project.archivedAt = new Date().toISOString();
    if (mode === "foreign-org") mocks.project.organizationId = "other";
    if (mode === "malformed")
      row.detail = MANUAL_AI_QUEUE_PREFIX + '"bad":true}';
    if (mode === "scope") {
      const e = JSON.parse(row.detail);
      e.billingCustomer.projectId = "other";
      row.detail = JSON.stringify(e);
    }
    if (mode === "expired")
      row.createdAt = new Date(Date.now() - 3600001).toISOString();
    if (mode === "future")
      row.createdAt = new Date(Date.now() + 60000).toISOString();
    if (mode === "invalid-date") row.createdAt = "invalid";
    if (mode === "no-prompts") mocks.prompts = [];
    if (mode === "row-config") row.configId = "other-config";
    if (mode === "row-project") row.projectId = "other-project";
    if (mode === "row-version") row.promptSetVersion = 99;
    if (mode === "plan-denied")
      mocks.access.mockRejectedValue(new Error("plan denied"));
    await runQueuedManualAiVisibilityChecks(budget());
    expect(row.status).toBe("failed");
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.explore).not.toHaveBeenCalled();
    await runQueuedManualAiVisibilityChecks(budget());
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it.each(["id", "projectId"])(
    "fingerprint binds the config %s",
    async (field) => {
      const snapshot = {
        config: mocks.config as any,
        project: mocks.project as any,
        prompts: mocks.prompts as any,
      };
      const before = await aiVisibilityRequestFingerprint(snapshot);
      const after = await aiVisibilityRequestFingerprint({
        ...snapshot,
        config: { ...snapshot.config, [field]: "other" },
      });
      expect(after).not.toBe(before);
    },
  );
  it("provider failure is terminal and never automatically replayed", async () => {
    const row = await queued();
    mocks.lookup.mockRejectedValue(new Error("provider uncertain"));
    await runQueuedManualAiVisibilityChecks(budget());
    expect(row.status).toBe("failed");
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    await runQueuedManualAiVisibilityChecks(budget());
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });
});

describe("dated holds at both queue boundaries", () => {
  const projectId = "d6d3c442-bedf-4c4c-b65b-17d0fcf4ec4d";
  it("a new pause after enqueue prevents paid work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T05:49:59Z"));
    mocks.config.projectId = projectId;
    mocks.project.id = projectId;
    const request = {
      ...input,
      projectId,
      billingCustomer: { ...input.billingCustomer, projectId },
    };
    const result = await enqueueManualAiVisibilityCheck(request);
    expect(result.ok).toBe(true);
    vi.setSystemTime(new Date("2026-10-01T05:50:00Z"));
    await runQueuedManualAiVisibilityChecks(budget());
    expect([...mocks.runs.values()][0].status).toBe("failed");
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("an already paused project cannot enqueue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
    mocks.config.projectId = projectId;
    mocks.project.id = projectId;
    await expect(
      enqueueManualAiVisibilityCheck({ ...input, projectId }),
    ).rejects.toThrow("paused");
    expect(mocks.runs.size).toBe(0);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
});
