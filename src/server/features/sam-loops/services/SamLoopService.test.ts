import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SamLoopRunGuards from "@/server/features/sam-loops/services/samLoopRunGuards";
import {
  firstUpdatedNextRunAt,
  mocks,
  requireString,
} from "./SamLoopService.fixture";

vi.mock("cloudflare:workers", async () => ({
  env: (await import("./SamLoopService.fixture")).mockEnv,
}));
vi.mock(
  "@/server/features/sam-loops/repositories/SamLoopRepository",
  async () =>
    (await import("./SamLoopService.fixture")).samLoopRepositoryModule,
);
vi.mock(
  "@/server/features/sam-loops/services/samLoopRunGuards",
  async (importOriginal) => ({
    ...(await importOriginal<typeof SamLoopRunGuards>()),
    beginSamLoopRun: (await import("./SamLoopService.fixture")).mocks
      .beginSamLoopRun,
  }),
);
vi.mock(
  "@/server/features/projects/repositories/ProjectRepository",
  async () =>
    (await import("./SamLoopService.fixture")).projectRepositoryModule,
);
vi.mock(
  "@/server/features/agency/AgencyScoreInputsService",
  async () =>
    (await import("./SamLoopService.fixture")).agencyScoreInputsModule,
);

import * as rankTracking from "@/shared/rank-tracking";
import {
  DEFAULT_SAM_LOOP_TEMPLATES,
  computeNextSamLoopRunAt,
} from "@/shared/sam-loops";
import {
  createSamLoop,
  seedDefaultSamLoopsForProject,
  updateSamLoop,
} from "./SamLoopService";

describe("createSamLoop", () => {
  it("rejects a custom loop carrying an approved template prompt verbatim", async () => {
    const templatePrompt = DEFAULT_SAM_LOOP_TEMPLATES.find(
      (t) => t.sourceType === "custom",
    )?.customPrompt;
    expect(templatePrompt).toBeTruthy();
    await expect(
      createSamLoop({
        projectId: "project_1",
        name: "CTR opportunities",
        sourceType: "custom",
        customPrompt: templatePrompt,
        cadence: "monthly",
      }),
    ).rejects.toThrow(/approved template/);
    expect(mocks.createLoop).not.toHaveBeenCalled();
  });
});

describe("updateSamLoop", () => {
  const ownPromptLoop = {
    id: "loop_1",
    projectId: "project_1",
    name: "My loop",
    sourceType: "custom",
    customPrompt: "my own benign prompt",
    cadence: "weekly",
    isEnabled: true,
    nextRunAt: "2026-09-01T05:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T15:00:00.000Z"));
    // Deterministic base time-of-day for schedule seeds (random otherwise).
    vi.spyOn(rankTracking, "computeNextCheckAt").mockReturnValue(
      "2026-09-20T05:00:00.000Z",
    );
    mocks.updateLoop.mockResolvedValue({ id: "loop_1" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects a prompt CHANGE onto an approved template prompt verbatim", async () => {
    const templatePrompt = DEFAULT_SAM_LOOP_TEMPLATES.find(
      (t) => t.sourceType === "custom",
    )?.customPrompt;
    expect(templatePrompt).toBeTruthy();
    mocks.getLoopById.mockResolvedValue({ ...ownPromptLoop });

    await expect(
      updateSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        customPrompt: templatePrompt,
      }),
    ).rejects.toThrow(/approved template/);
    await expect(
      updateSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        customPrompt: templatePrompt,
      }),
    ).rejects.toThrow(/starter loops/);
    expect(mocks.updateLoop).not.toHaveBeenCalled();
  });

  it("lets a template-family loop swap to another approved template prompt", async () => {
    // The loop already lives in the template family: swapping among approved
    // template prompts grants nothing the starter-loops button doesn't, and
    // keeps a seeded loop repairable.
    const reviewWatch = requireString(
      DEFAULT_SAM_LOOP_TEMPLATES.find((t) => t.name === "Review watch")
        ?.customPrompt,
      "Review watch prompt",
    );
    const ctr = requireString(
      DEFAULT_SAM_LOOP_TEMPLATES.find((t) => t.name === "CTR opportunities")
        ?.customPrompt,
      "CTR opportunities prompt",
    );
    mocks.getLoopById.mockResolvedValue({
      ...ownPromptLoop,
      name: "Review watch",
      customPrompt: reviewWatch,
    });

    await expect(
      updateSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        customPrompt: ctr,
      }),
    ).resolves.toBeDefined();
    expect(mocks.updateLoop).toHaveBeenCalledWith(
      "loop_1",
      "project_1",
      expect.objectContaining({ customPrompt: ctr }),
    );
  });

  it("lets a seeded loop round-trip its own template prompt unchanged", async () => {
    // Seeded loops legitimately HOLD a template prompt; updating an unrelated
    // field while the client re-submits the same prompt must not trip the rule.
    const templatePrompt = requireString(
      DEFAULT_SAM_LOOP_TEMPLATES.find((t) => t.sourceType === "custom")
        ?.customPrompt,
      "custom template prompt",
    );
    mocks.getLoopById.mockResolvedValue({
      ...ownPromptLoop,
      name: "CTR opportunities",
      customPrompt: templatePrompt,
      cadence: "monthly",
    });

    await expect(
      updateSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        isEnabled: false,
        customPrompt: templatePrompt,
      }),
    ).resolves.toBeDefined();
    expect(mocks.updateLoop).toHaveBeenCalled();
  });

  it("seeds the cadence re-anchor with the FINAL name on a simultaneous rename", async () => {
    mocks.getLoopById.mockResolvedValue({
      ...ownPromptLoop,
      name: "Old name",
    });

    await updateSamLoop({
      projectId: "project_1",
      loopId: "loop_1",
      cadence: "monthly",
      name: "New name",
    });

    const scheduled = firstUpdatedNextRunAt();
    const finalNameSeed = computeNextSamLoopRunAt(
      "monthly",
      undefined,
      "project_1:New name",
    );
    const oldNameSeed = computeNextSamLoopRunAt(
      "monthly",
      undefined,
      "project_1:Old name",
    );
    // Precondition: the two seeds must land on different dates, else this
    // test cannot tell them apart — pick different names if it ever fails.
    expect(finalNameSeed).not.toBe(oldNameSeed);
    expect(scheduled).toBe(finalNameSeed);
  });

  it("seeds with projectId:name when enabling an unscheduled loop", async () => {
    mocks.getLoopById.mockResolvedValue({
      ...ownPromptLoop,
      name: "Review watch",
      isEnabled: false,
      nextRunAt: null,
    });

    await updateSamLoop({
      projectId: "project_1",
      loopId: "loop_1",
      isEnabled: true,
    });

    const scheduled = firstUpdatedNextRunAt();
    expect(scheduled).toBe(
      computeNextSamLoopRunAt("weekly", undefined, "project_1:Review watch"),
    );
  });
});

describe("seedDefaultSamLoopsForProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates default loops for a project", async () => {
    const created = [
      { id: "loop_a", name: "Site health" },
      { id: "loop_b", name: "Rank slippage" },
    ];
    mocks.ensureDefaultLoops.mockResolvedValue(created);

    await expect(seedDefaultSamLoopsForProject("project_1")).resolves.toEqual(
      created,
    );
    expect(mocks.ensureDefaultLoops).toHaveBeenCalledWith("project_1");
  });

  it("creates no duplicates when defaults already exist", async () => {
    mocks.ensureDefaultLoops.mockResolvedValueOnce([
      { id: "loop_a", name: "Site health" },
    ]);
    mocks.ensureDefaultLoops.mockResolvedValueOnce([]);

    await seedDefaultSamLoopsForProject("project_1");
    await expect(seedDefaultSamLoopsForProject("project_1")).resolves.toEqual(
      [],
    );
    expect(mocks.ensureDefaultLoops).toHaveBeenCalledTimes(2);
  });
});
