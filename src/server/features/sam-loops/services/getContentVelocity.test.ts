import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLoopsForProject: vi.fn(),
  getContentVelocityForProject: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { SAM_LOOP_WORKFLOW: {} },
}));
vi.mock(
  "@/server/features/sam-loops/repositories/SamLoopRepository",
  () => ({
    SamLoopRepository: {
      getLoopsForProject: mocks.getLoopsForProject,
      getContentVelocityForProject: mocks.getContentVelocityForProject,
    },
  }),
);

import { getContentVelocity } from "./SamLoopService";

describe("getContentVelocity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buckets drafted and completed-without-draft across the 3-month window", async () => {
    mocks.getLoopsForProject.mockResolvedValue([
      {
        id: "loop_monthly",
        name: "Monthly content",
        skillName: null,
        cadence: "monthly",
        isEnabled: true,
      },
      {
        id: "loop_brief",
        name: "Brief loop",
        skillName: "content-brief",
        cadence: "weekly",
        isEnabled: false,
      },
      {
        id: "loop_rank",
        name: "Rank slippage",
        skillName: "rank-slippage",
        cadence: "daily",
        isEnabled: true,
      },
    ]);
    mocks.getContentVelocityForProject.mockResolvedValue([
      {
        loopId: "loop_monthly",
        loopName: "Monthly content",
        cadence: "monthly",
        isEnabled: true,
        finishedAt: "2026-07-10T00:00:00.000Z",
        hasReport: true,
      },
      {
        loopId: "loop_monthly",
        loopName: "Monthly content",
        cadence: "monthly",
        isEnabled: true,
        finishedAt: "2026-08-01T00:00:00.000Z",
        hasReport: false,
      },
      {
        loopId: "loop_brief",
        loopName: "Brief loop",
        cadence: "weekly",
        isEnabled: false,
        finishedAt: "2026-09-01T00:00:00.000Z",
        hasReport: true,
      },
    ]);

    await expect(getContentVelocity("project_1")).resolves.toEqual({
      months: ["2026-07", "2026-08", "2026-09"],
      loops: [
        {
          loopId: "loop_monthly",
          loopName: "Monthly content",
          cadence: "monthly",
          isEnabled: true,
          expectedPerMonth: 1,
          drafted: { "2026-07": 1, "2026-08": 0, "2026-09": 0 },
          completedWithoutDraft: { "2026-07": 0, "2026-08": 1, "2026-09": 0 },
        },
        {
          loopId: "loop_brief",
          loopName: "Brief loop",
          cadence: "weekly",
          isEnabled: false,
          expectedPerMonth: 4,
          drafted: { "2026-07": 0, "2026-08": 0, "2026-09": 1 },
          completedWithoutDraft: { "2026-07": 0, "2026-08": 0, "2026-09": 0 },
        },
      ],
    });

    expect(mocks.getContentVelocityForProject).toHaveBeenCalledWith(
      "project_1",
      "2026-07-01T00:00:00.000Z",
    );
  });

  it("lists content loops with zero runs and maps expectedPerMonth by cadence", async () => {
    mocks.getLoopsForProject.mockResolvedValue([
      {
        id: "loop_draft",
        name: "Draft loop",
        skillName: "content-draft",
        cadence: "daily",
        isEnabled: true,
      },
    ]);
    mocks.getContentVelocityForProject.mockResolvedValue([]);

    await expect(getContentVelocity("project_1")).resolves.toEqual({
      months: ["2026-07", "2026-08", "2026-09"],
      loops: [
        {
          loopId: "loop_draft",
          loopName: "Draft loop",
          cadence: "daily",
          isEnabled: true,
          expectedPerMonth: 30,
          drafted: { "2026-07": 0, "2026-08": 0, "2026-09": 0 },
          completedWithoutDraft: { "2026-07": 0, "2026-08": 0, "2026-09": 0 },
        },
      ],
    });
  });
});
