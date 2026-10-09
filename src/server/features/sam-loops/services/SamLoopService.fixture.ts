import { vi } from "vitest";
import type { SamLoopRepository } from "../repositories/SamLoopRepository";

// Shared mocks for the SamLoopService*.test.ts files. vi.mock only hoists
// within a test file, so each file wires these into its own vi.mock factories.

export const mockEnv: {
  SAM_LOOP_WORKFLOW: object;
  SAM_LOOP_DAILY_RUN_CAP?: string;
} = { SAM_LOOP_WORKFLOW: {} };

export const mocks = {
  getLoopById: vi.fn(),
  getLoopsForProject: vi.fn(),
  claimDueLoop:
    vi.fn<
      (
        input: Parameters<typeof SamLoopRepository.claimDueLoop>[0],
      ) => Promise<boolean>
    >(),
  updateLoop:
    vi.fn<
      (
        loopId: string,
        projectId: string,
        data: Parameters<typeof SamLoopRepository.updateLoop>[2],
      ) => Promise<unknown>
    >(),
  createLoop: vi.fn(),
  beginSamLoopRun: vi.fn(),
  ensureDefaultLoops: vi.fn(),
  countRunsCreatedSince: vi.fn(),
  getProjectById: vi.fn(),
  getProjectsByDomain: vi.fn(),
  getAgencyScoreInputsGlobal: vi.fn(),
};

export const samLoopRepositoryModule = {
  SamLoopRepository: {
    getLoopById: mocks.getLoopById,
    getLoopsForProject: mocks.getLoopsForProject,
    claimDueLoop: mocks.claimDueLoop,
    updateLoop: mocks.updateLoop,
    createLoop: mocks.createLoop,
    ensureDefaultLoops: mocks.ensureDefaultLoops,
    countRunsCreatedSince: mocks.countRunsCreatedSince,
  },
};

export const projectRepositoryModule = {
  ProjectRepository: {
    getProjectById: mocks.getProjectById,
    getProjectsByDomain: mocks.getProjectsByDomain,
  },
};

export const agencyScoreInputsModule = {
  getAgencyScoreInputsGlobal: mocks.getAgencyScoreInputsGlobal,
};

export function requireString(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`expected ${what} string`);
  return value;
}

/** nextRunAt passed to the first SamLoopRepository.updateLoop call. */
export function firstUpdatedNextRunAt(): string {
  return requireString(
    mocks.updateLoop.mock.calls[0]?.[2].nextRunAt,
    "updateLoop nextRunAt",
  );
}
