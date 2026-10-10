import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SamLoopRepository } from "../repositories/SamLoopRepository";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";

type DueLoop = Awaited<
  ReturnType<typeof SamLoopRepository.getDueLoopsWithOrganization>
>[number];

const mocks = vi.hoisted(() => ({
  getDueLoopsWithOrganization: vi.fn<() => Promise<DueLoop[]>>(),
  claimDueLoop: vi.fn<() => Promise<boolean>>(),
  countRunsCreatedSince: vi.fn<() => Promise<number>>(),
  beginSamLoopRun: vi.fn<() => Promise<{ ok: true; runId: string }>>(),
  sweepExpiredBoxRuns: vi.fn<() => Promise<{ expired: number }>>(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("../repositories/SamLoopRepository", () => ({
  SamLoopRepository: mocks,
}));
vi.mock("./samBoxSweep", () => ({
  sweepExpiredBoxRuns: mocks.sweepExpiredBoxRuns,
}));
vi.mock("./samLoopRunGuards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./samLoopRunGuards")>()),
  beginSamLoopRun: mocks.beginSamLoopRun,
}));

import { runScheduledSamLoops } from "./scheduledSamLoops";

function dueLoop(id: string, overrides: Partial<DueLoop> = {}): DueLoop {
  return {
    id,
    projectId: "project",
    name: "Site health",
    sourceType: "skill",
    skillName: "site-health",
    customPrompt: null,
    cadence: "monthly",
    nextRunAt: "2026-01-01T00:00:00.000Z",
    organizationId: "org",
    domain: "niceseo.ai",
    loopsEnabled: true,
    ...overrides,
  };
}

function boxLoop(name: "On-page priorities" | "CTR opportunities"): DueLoop {
  const template = DEFAULT_SAM_LOOP_TEMPLATES.find(
    (entry) => entry.name === name,
  );
  if (!template || !("customPrompt" in template))
    throw new Error("Missing box template");
  return dueLoop(name, {
    name,
    sourceType: "custom",
    skillName: null,
    customPrompt: template.customPrompt,
  });
}

function testEnv(mode?: string): Env {
  return { SAM_LOOP_WORKFLOW: {}, SAM_LOOP_GROK_BOX: mode } as unknown as Env;
}

beforeEach(() => {
  mocks.getDueLoopsWithOrganization.mockResolvedValue([
    boxLoop("On-page priorities"),
    boxLoop("CTR opportunities"),
    dueLoop("other"),
  ]);
  mocks.claimDueLoop.mockResolvedValue(true);
  mocks.countRunsCreatedSince.mockResolvedValue(0);
  mocks.beginSamLoopRun.mockResolvedValue({ ok: true, runId: "run" });
  mocks.sweepExpiredBoxRuns.mockResolvedValue({ expired: 0 });
});

describe("scheduled box loops", () => {
  it.each(["off", undefined])(
    "mode %s keeps box kinds on the Workflow path",
    async (mode) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await runScheduledSamLoops(testEnv(mode));
      expect(mocks.claimDueLoop).toHaveBeenCalledTimes(3);
      expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(3);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ started: 3, boxDeferred: 0 }),
      );
    },
  );

  it("mode on defers exact box templates and runs other and edited loops", async () => {
    const edited = boxLoop("On-page priorities");
    edited.id = "edited";
    edited.customPrompt += " edited";
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      boxLoop("On-page priorities"),
      boxLoop("CTR opportunities"),
      dueLoop("other"),
      edited,
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScheduledSamLoops(testEnv("on"));
    expect(mocks.claimDueLoop).toHaveBeenCalledTimes(2);
    expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(2);
    for (const loopId of ["other", "edited"]) {
      expect(mocks.claimDueLoop).toHaveBeenCalledWith(
        expect.objectContaining({ loopId }),
      );
      expect(mocks.beginSamLoopRun).toHaveBeenCalledWith(
        expect.objectContaining({ loopId }),
      );
    }
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ started: 2, boxDeferred: 2 }),
    );
  });

  it.each(["off", "on"])(
    "sweeps before the daily-cap check in mode %s",
    async (mode) => {
      mocks.countRunsCreatedSince.mockResolvedValue(40);
      vi.spyOn(console, "error").mockImplementation(() => {});
      await runScheduledSamLoops(testEnv(mode));
      expect(mocks.sweepExpiredBoxRuns).toHaveBeenCalledTimes(1);
      expect(
        mocks.sweepExpiredBoxRuns.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mocks.countRunsCreatedSince.mock.invocationCallOrder[0] ?? 0,
      );
      expect(mocks.getDueLoopsWithOrganization).not.toHaveBeenCalled();
    },
  );

  it("logs sweep errors and continues scheduling", async () => {
    mocks.sweepExpiredBoxRuns.mockRejectedValueOnce(
      new Error("sweep unavailable"),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runScheduledSamLoops(testEnv("off"));
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "sam_box_sweep_failed" }),
    );
    expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(3);
  });
});
