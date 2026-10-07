import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepExpiredBoxRuns } from "./samBoxSweep";
import { SAM_BOX_LEASE_SECONDS } from "./samBoxTypes";
import { computeNextSamLoopRunAt } from "@/shared/sam-loops";
import type { SamBoxFinishData } from "./samBoxFinalize";

type Run = { id: string; loopId: string; projectId: string };
const mocks = vi.hoisted(() => ({
  env: { SAM_LOOP_GROK_BOX: "off" },
  getExpiredBoxRuns:
    vi.fn<(nowIso: string, leaseSeconds: number) => Promise<Run[]>>(),
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
  getLoopById:
    vi.fn<
      () => Promise<{ name: string; cadence: "monthly"; nextRunAt: string }>
    >(),
  claimDueLoop: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("cloudflare:workers", () => ({ env: mocks.env }));
vi.mock("@/server/features/sam-loops/repositories/SamLoopRepository", () => ({
  SamLoopRepository: mocks,
}));

const now = new Date("2026-10-07T13:35:00.123Z");
const run: Run = {
  id: "box-expired",
  loopId: "loop-1",
  projectId: "project-1",
};
const loop = {
  name: "CTR opportunities",
  cadence: "monthly" as const,
  nextRunAt: "2026-10-01T13:00:00.000Z",
};
const expiredData = {
  status: "failed",
  error: "Box lease expired before a result was posted.",
  report: "Not measured — Box lease expired before a result was posted.",
  costNote: "box:grok-sub (lease expired)",
  stepsUsed: null,
  proposalsQueued: 0,
  finishedAt: now.toISOString(),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.getExpiredBoxRuns.mockResolvedValue([run]);
  mocks.finishRunIfRunning.mockResolvedValue(true);
  mocks.updateLoop.mockResolvedValue(undefined);
  mocks.getLoopById.mockResolvedValue(loop);
  mocks.claimDueLoop.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

describe("sweepExpiredBoxRuns", () => {
  it.each(["on", "off"])(
    "finalizes repository-selected expired box leases and advances cadence in mode %s",
    async (mode) => {
      mocks.env.SAM_LOOP_GROK_BOX = mode;
      expect(await sweepExpiredBoxRuns(now)).toEqual({ expired: 1 });
      expect(mocks.getExpiredBoxRuns).toHaveBeenCalledWith(
        now.toISOString(),
        SAM_BOX_LEASE_SECONDS,
      );
      expect(mocks.finishRunIfRunning).toHaveBeenCalledExactlyOnceWith(
        run.id,
        expiredData,
      );
      expect(mocks.updateLoop).toHaveBeenCalledWith(run.loopId, run.projectId, {
        lastRunAt: now.toISOString(),
      });
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
    },
  );

  it("defaults the query and terminal timestamp to now", async () => {
    await sweepExpiredBoxRuns();
    expect(mocks.getExpiredBoxRuns).toHaveBeenCalledWith(
      now.toISOString(),
      SAM_BOX_LEASE_SECONDS,
    );
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(run.id, expiredData);
  });

  it("does not touch runs excluded by the repository's box-expiry query", async () => {
    mocks.getExpiredBoxRuns.mockResolvedValue([]);
    expect(await sweepExpiredBoxRuns(now)).toEqual({ expired: 0 });
    expect(mocks.finishRunIfRunning).not.toHaveBeenCalled();
    expect(mocks.updateLoop).not.toHaveBeenCalled();
  });

  it("counts only winning terminal writes and leaves losing loops alone", async () => {
    const other = { ...run, id: "box-other", loopId: "loop-other" };
    mocks.getExpiredBoxRuns.mockResolvedValue([run, other]);
    mocks.finishRunIfRunning
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    expect(await sweepExpiredBoxRuns(now)).toEqual({ expired: 1 });
    expect(mocks.updateLoop).toHaveBeenCalledExactlyOnceWith(
      other.loopId,
      other.projectId,
      { lastRunAt: now.toISOString() },
    );
  });

  it("logs a per-run failure and continues finalizing later leases", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const other = { ...run, id: "box-other", loopId: "loop-other" };
    mocks.getExpiredBoxRuns.mockResolvedValue([run, other]);
    mocks.finishRunIfRunning.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    expect(await sweepExpiredBoxRuns(now)).toEqual({ expired: 1 });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(mocks.finishRunIfRunning).toHaveBeenLastCalledWith(
      other.id,
      expiredData,
    );
    expect(mocks.updateLoop).toHaveBeenCalledExactlyOnceWith(
      other.loopId,
      other.projectId,
      { lastRunAt: now.toISOString() },
    );
  });

  it("logs a post-terminal loop-update failure and continues without counting partial completion", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const other = { ...run, id: "box-other", loopId: "loop-other" };
    mocks.getExpiredBoxRuns.mockResolvedValue([run, other]);
    mocks.updateLoop.mockRejectedValueOnce(
      new Error("loop update unavailable"),
    );
    expect(await sweepExpiredBoxRuns(now)).toEqual({ expired: 1 });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(mocks.getLoopById).toHaveBeenCalledExactlyOnceWith(
      other.loopId,
      other.projectId,
    );
  });

  it("absorbs and logs an expiry-query failure", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getExpiredBoxRuns.mockRejectedValueOnce(
      new Error("query unavailable"),
    );
    await expect(sweepExpiredBoxRuns(now)).resolves.toEqual({ expired: 0 });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(mocks.finishRunIfRunning).not.toHaveBeenCalled();
  });
});
