import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeNextSamLoopRunAt } from "@/shared/sam-loops";
import {
  advanceSamBoxLoop,
  finishSamBoxRun,
  type SamBoxFinishData,
} from "./samBoxFinalize";

type Loop = {
  name: string;
  cadence: "daily" | "weekly" | "monthly";
  nextRunAt: string | null;
};
const mocks = vi.hoisted(() => ({
  getLoopById:
    vi.fn<(loopId: string, projectId: string) => Promise<Loop | null>>(),
  claimDueLoop:
    vi.fn<
      (input: {
        loopId: string;
        projectId: string;
        observedNextRunAt: string;
        nextRunAt: string;
      }) => Promise<boolean>
    >(),
  finishRunIfRunning:
    vi.fn<(runId: string, data: SamBoxFinishData) => Promise<boolean>>(),
  updateLoop:
    vi.fn<
      (
        loopId: string,
        projectId: string,
        data: { lastRunAt: string },
      ) => Promise<void>
    >(),
}));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/sam-loops/repositories/SamLoopRepository", () => ({
  SamLoopRepository: mocks,
}));

const now = "2026-10-07T13:35:00.123Z";
const run = { id: "run-1", loopId: "loop-1", projectId: "project-1" };
const loop: Loop = {
  name: "CTR opportunities",
  cadence: "monthly",
  nextRunAt: "2026-10-01T13:00:00.000Z",
};
const data: SamBoxFinishData = {
  status: "completed",
  error: null,
  report: "Measured",
  proposalsQueued: 2,
  stepsUsed: 1,
  costNote: "box:grok-sub grok-4.6",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.getLoopById.mockResolvedValue(loop);
  mocks.claimDueLoop.mockResolvedValue(true);
  mocks.finishRunIfRunning.mockResolvedValue(true);
  mocks.updateLoop.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("advanceSamBoxLoop", () => {
  it.each([
    null,
    { ...loop, nextRunAt: null },
    { ...loop, nextRunAt: "2026-11-01T13:00:00.000Z" },
  ])(
    "leaves missing, unscheduled, and future loops alone (%j)",
    async (row) => {
      mocks.getLoopById.mockResolvedValue(row);
      await advanceSamBoxLoop(run.loopId, run.projectId);
      expect(mocks.getLoopById).toHaveBeenCalledWith(run.loopId, run.projectId);
      expect(mocks.claimDueLoop).not.toHaveBeenCalled();
    },
  );

  it.each(["", "not-a-date"])(
    "refuses corrupt schedule timestamps (%j) without a schedule mutation",
    async (nextRunAt) => {
      mocks.getLoopById.mockResolvedValue({ ...loop, nextRunAt });
      await expect(
        advanceSamBoxLoop(run.loopId, run.projectId),
      ).rejects.toThrow("invalid next run timestamp");
      expect(mocks.claimDueLoop).not.toHaveBeenCalled();
    },
  );

  it("advances a due loop using its observed anchor and the shared seeded cadence", async () => {
    await advanceSamBoxLoop(run.loopId, run.projectId);
    expect(mocks.claimDueLoop).toHaveBeenCalledWith({
      loopId: run.loopId,
      projectId: run.projectId,
      observedNextRunAt: loop.nextRunAt,
      nextRunAt: computeNextSamLoopRunAt(
        loop.cadence,
        loop.nextRunAt,
        `${run.projectId}:${loop.name}`,
      ),
    });
  });

  it("treats a timestamp equal to now as due and ignores a lost advance CAS", async () => {
    mocks.getLoopById.mockResolvedValue({ ...loop, nextRunAt: now });
    mocks.claimDueLoop.mockResolvedValue(false);
    await expect(
      advanceSamBoxLoop(run.loopId, run.projectId),
    ).resolves.toBeUndefined();
    expect(mocks.claimDueLoop).toHaveBeenCalledTimes(1);
  });
});

describe("finishSamBoxRun", () => {
  it("returns false after a lost terminal CAS without touching the loop", async () => {
    mocks.finishRunIfRunning.mockResolvedValue(false);
    expect(
      await finishSamBoxRun({ run, data, touchLastRun: true, advance: true }),
    ).toBe(false);
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(run.id, {
      ...data,
      finishedAt: now,
    });
    expect(mocks.updateLoop).not.toHaveBeenCalled();
    expect(mocks.getLoopById).not.toHaveBeenCalled();
    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
  });

  it("uses an explicit finishedAt and updates lastRunAt only after winning", async () => {
    const finishedAt = "2026-10-07T13:34:59.456Z";
    expect(
      await finishSamBoxRun({
        run,
        data: { ...data, finishedAt },
        touchLastRun: true,
        advance: true,
      }),
    ).toBe(true);
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(run.id, {
      ...data,
      finishedAt,
    });
    expect(mocks.updateLoop).toHaveBeenCalledWith(run.loopId, run.projectId, {
      lastRunAt: finishedAt,
    });
    expect(mocks.finishRunIfRunning.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateLoop.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.updateLoop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getLoopById.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    { touchLastRun: false, advance: false },
    { touchLastRun: true, advance: false },
    { touchLastRun: false, advance: true },
  ])("honors independent terminal side-effect flags %j", async (flags) => {
    expect(await finishSamBoxRun({ run, data, ...flags })).toBe(true);
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(run.id, {
      ...data,
      finishedAt: now,
    });
    expect(mocks.updateLoop).toHaveBeenCalledTimes(flags.touchLastRun ? 1 : 0);
    expect(mocks.getLoopById).toHaveBeenCalledTimes(flags.advance ? 1 : 0);
  });
});
