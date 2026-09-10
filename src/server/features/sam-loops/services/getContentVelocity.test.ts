import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import { article, saved, source } from "./monthlyContent.fixture";
import {
  hasVerifiedMonthlyDraft,
  validateMonthlyContent,
} from "./monthlyContentResult";

const mocks = vi.hoisted(() => ({
  getLoopsForProject: vi.fn(),
  getContentVelocityForProject: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { SAM_LOOP_WORKFLOW: {} },
}));
vi.mock("@/server/features/sam-loops/repositories/SamLoopRepository", () => ({
  SamLoopRepository: {
    getLoopsForProject: mocks.getLoopsForProject,
    getContentVelocityForProject: mocks.getContentVelocityForProject,
  },
}));

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

  it("counts a verified article after the approved monthly loop is renamed", async () => {
    const template = DEFAULT_SAM_LOOP_TEMPLATES.find(
      (loop) => loop.name === "Monthly content",
    )!;
    const checked = await validateMonthlyContent(
      article,
      [{ toolResults: [saved, source] }],
      "example.com",
    );
    expect(checked.error).toBeNull();
    const renamed = {
      id: "loop_editorial",
      name: "Editorial routine",
      sourceType: template.sourceType,
      skillName: null,
      customPrompt: template.customPrompt,
      cadence: "monthly",
      isEnabled: true,
    };
    mocks.getLoopsForProject.mockResolvedValue([renamed]);
    mocks.getContentVelocityForProject.mockResolvedValue([
      {
        loopId: renamed.id,
        loopName: renamed.name,
        cadence: renamed.cadence,
        isEnabled: renamed.isEnabled,
        finishedAt: "2026-09-04T12:00:00.000Z",
        hasDraft: await hasVerifiedMonthlyDraft(checked.report),
      },
    ]);

    const result = await getContentVelocity("project_example");
    expect(result.loops).toEqual([
      {
        loopId: renamed.id,
        loopName: renamed.name,
        cadence: "monthly",
        isEnabled: true,
        expectedPerMonth: 1,
        drafted: { "2026-07": 0, "2026-08": 0, "2026-09": 1 },
        completedWithoutDraft: { "2026-07": 0, "2026-08": 0, "2026-09": 0 },
      },
    ]);
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
        hasDraft: true,
      },
      {
        loopId: "loop_monthly",
        loopName: "Monthly content",
        cadence: "monthly",
        isEnabled: true,
        finishedAt: "2026-08-01T00:00:00.000Z",
        hasDraft: false,
      },
      {
        loopId: "loop_brief",
        loopName: "Brief loop",
        cadence: "weekly",
        isEnabled: false,
        finishedAt: "2026-09-01T00:00:00.000Z",
        hasDraft: true,
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

  it("excludes empty-string report runs from drafted count", async () => {
    mocks.getLoopsForProject.mockResolvedValue([
      {
        id: "loop_content",
        name: "Monthly content",
        skillName: null,
        cadence: "monthly",
        isEnabled: true,
      },
    ]);
    mocks.getContentVelocityForProject.mockResolvedValue([
      {
        loopId: "loop_content",
        loopName: "Monthly content",
        cadence: "monthly",
        isEnabled: true,
        finishedAt: "2026-08-10T00:00:00.000Z",
        hasDraft: false,
      },
    ]);

    await expect(getContentVelocity("project_1")).resolves.toEqual({
      months: ["2026-07", "2026-08", "2026-09"],
      loops: [
        {
          loopId: "loop_content",
          loopName: "Monthly content",
          cadence: "monthly",
          isEnabled: true,
          expectedPerMonth: 1,
          drafted: { "2026-07": 0, "2026-08": 0, "2026-09": 0 },
          completedWithoutDraft: { "2026-07": 0, "2026-08": 1, "2026-09": 0 },
        },
      ],
    });
  });

  it("throws for unknown cadence when mapping expectedPerMonth", async () => {
    mocks.getLoopsForProject.mockResolvedValue([
      {
        id: "loop_bad",
        name: "Monthly content",
        skillName: null,
        cadence: "quarterly",
        isEnabled: true,
      },
    ]);
    mocks.getContentVelocityForProject.mockResolvedValue([]);

    await expect(getContentVelocity("project_1")).rejects.toThrow(
      "unknown cadence: quarterly",
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
