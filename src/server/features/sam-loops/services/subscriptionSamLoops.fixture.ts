import { beforeEach, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";

type Run = {
  id: string;
  projectId: string;
  loopId: string;
  status: string;
  costNote: string | null;
  startedAt?: string;
  stepsUsed?: number;
  proposalsQueued?: number;
  finishedAt?: string;
};

const mocks = vi.hoisted(() => ({
  env: {
    SAM_LOOP_EXECUTOR: "subscription",
    AGENCY_SCORE_EXPORT_TOKEN: "fixture-signing-token",
  },
  project: vi.fn(),
  loop: vi.fn(),
  prepare: vi.fn(),
  active: vi.fn(),
  count: vi.fn(),
  claim: vi.fn(),
  create:
    vi.fn<
      (data: Pick<Run, "id" | "loopId" | "projectId">) => Promise<boolean>
    >(),
  getRun: vi.fn(),
  cas: vi.fn<
    (
      id: string,
      expected: string | null,
      changes: Partial<Run>,
      terminal?: { loopId: string; projectId: string; finishedAt: string },
      houseScope?: { projectId: string; loopId: string; domain: "niceseo.ai" },
    ) => Promise<boolean>
  >(),
  updateLoop: vi.fn(),
  due: vi.fn(),
  execute:
    vi.fn<
      (input: Record<string, unknown>, context?: unknown) => Promise<unknown>
    >(),
  admit: vi.fn<(data: Omit<Run, "status">) => Promise<boolean>>(),
  recent: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: mocks.env }));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectById: mocks.project },
}));
vi.mock("./runHeadlessSamLoop", () => ({ prepareSamLoop: mocks.prepare }));
vi.mock("./samLoopRunGuards", () => ({ getSamLoopDailyRunCap: () => 20 }));
vi.mock("../repositories/SamLoopRepository", () => ({
  SamLoopRepository: {
    getLoopById: mocks.loop,
    getActiveRunForLoop: mocks.active,
    getRunsForLoop: mocks.recent,
    countRunsCreatedSince: mocks.count,
    claimDueLoop: mocks.claim,
    tryCreateRun: mocks.create,
    claimSubscriptionRun: mocks.admit,
    getRunById: mocks.getRun,
    compareAndSwapSubscriptionRun: mocks.cas,
    updateLoop: mocks.updateLoop,
    getDueLoopsWithOrganization: mocks.due,
  },
}));
import { postSubscriptionLoopRequest } from "./subscriptionSamLoops";

export const projectId = "22222222-2222-4222-8222-222222222222";
export const loopId = "11111111-1111-4111-8111-111111111111";
export const scheduledFor = "2026-10-01T00:00:00.000Z";
let run: Run | null;
export function currentRun() {
  return run;
}

beforeEach(() => {
  vi.resetAllMocks();
  run = null;
  mocks.env.SAM_LOOP_EXECUTOR = "subscription";
  mocks.env.AGENCY_SCORE_EXPORT_TOKEN = "fixture-signing-token";
  mocks.project.mockResolvedValue({
    id: projectId,
    name: "House",
    domain: "niceseo.ai",
    organizationId: "fixture-org",
    archivedAt: null,
    loopsEnabled: false,
  });
  mocks.loop.mockResolvedValue({
    id: loopId,
    projectId,
    name: "On-page priorities",
    isEnabled: true,
    sourceType: "custom",
    skillName: null,
    customPrompt: "fixture",
    nextRunAt: scheduledFor,
    cadence: "weekly",
  });
  mocks.execute.mockResolvedValue({ data: { id: "fixture-proposal" } });
  mocks.prepare.mockImplementation(async () => ({
    system: "Sam",
    prompt: "fixture",
    monthly: false,
    domain: "niceseo.ai",
    tools: {
      propose_homegrown_otto_fixes: tool({
        inputSchema: z.object({ title: z.string() }).strict(),
        execute: mocks.execute,
      }),
      get_business_reviews: tool({
        inputSchema: z.object({}),
        execute: mocks.execute,
      }),
    },
  }));
  mocks.active.mockImplementation(async () =>
    run && ["pending", "running"].includes(run.status) ? run : null,
  );
  mocks.count.mockResolvedValue(0);
  mocks.recent.mockResolvedValue([]);
  mocks.claim.mockResolvedValue(true);
  mocks.create.mockImplementation(async (data) => {
    run = { ...data, status: "pending", costNote: null };
    return true;
  });
  mocks.admit.mockImplementation(async (data) => {
    run = { ...data, status: "running" };
    return true;
  });
  mocks.getRun.mockImplementation(async () => run && { ...run });
  mocks.cas.mockImplementation(async (id, expected, changes) => {
    if (
      !run ||
      run.id !== id ||
      run.costNote !== expected ||
      !["pending", "running"].includes(run.status)
    )
      return false;
    run = { ...run, ...changes };
    return true;
  });
});

export async function claim() {
  return z
    .object({
      runId: z.string(),
      receipt: z.string(),
      tools: z.array(z.object({ name: z.string() })),
    })
    .parse(
      await postSubscriptionLoopRequest({
        action: "claim",
        projectId,
        loopId,
        scheduledFor,
        model: "grok-4.7",
      }),
    );
}

export const sparseOutput: unknown[] = [];
sparseOutput.length = 1;

export function getMocks() {
  return mocks;
}
