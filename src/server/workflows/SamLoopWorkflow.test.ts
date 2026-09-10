import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { SamLoopWorkflow } from "./SamLoopWorkflow";

const mocks = vi.hoisted(() => ({ getRunById: vi.fn(), getLoopById: vi.fn(), getProjectById: vi.fn(), updateRun: vi.fn(), updateLoop: vi.fn(), execute: vi.fn(), fail: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: vi.fn() }));
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: class extends Error {} }));
vi.mock("@/db", () => ({ withPgClient: (fn: () => unknown) => fn() }));
vi.mock("@/server/features/sam-loops/repositories/SamLoopRepository", () => ({ SamLoopRepository: mocks }));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({ ProjectRepository: mocks }));
vi.mock("@/server/features/sam-loops/services/runHeadlessSamLoop", () => ({ runHeadlessSamLoop: mocks.execute }));
vi.mock("@/server/features/sam-loops/services/samLoopRunGuards", () => ({ failSamLoopRunIfActive: mocks.fail }));
vi.mock("./pgStep", () => ({ pgStep: (_step: unknown, _name: string, _config: unknown, fn: () => unknown) => fn() }));
vi.mock("./selfHostBaseUrl", () => ({ selfHostBaseUrl: () => "https://seo.example" }));

const payload = { runId: "run_1", loopId: "loop_1", projectId: "project_1", organizationId: "org_1", trigger: "scheduled" as const };
function run() {
  // The mocked Cloudflare base class has no runtime constructor requirements.
  const workflow = new SamLoopWorkflow({} as ExecutionContext, {} as Env);
  return workflow.run({ payload } as WorkflowEvent<typeof payload>, {} as WorkflowStep);
}
describe("Sam loop result persistence", () => {
  beforeEach(() => {
    mocks.getRunById.mockResolvedValue({ status: "running" });
    mocks.getLoopById.mockResolvedValue({ isEnabled: true, name: "Monthly content", sourceType: "custom", customPrompt: "approved", skillName: null });
    mocks.getProjectById.mockResolvedValue({ id: "project_1", name: "Example", domain: "example.com", locationCode: 2840, languageCode: "en" });
  });
  it.each(["completed", "failed"] as const)("persists a %s outcome with the known report and spend", async (status) => {
    const execution = { status, error: status === "failed" ? "No source evidence" : null, report: status === "failed" ? "Draft not completed" : "Full article", proposalsQueued: 0, stepsUsed: 7, costNote: "OpenRouter ≈ $0.2000" };
    mocks.execute.mockResolvedValue(execution);
    await run();
    expect(mocks.updateRun).toHaveBeenLastCalledWith("run_1", { status, error: execution.error, report: execution.report, proposalsQueued: 0, stepsUsed: 7, costNote: execution.costNote, finishedAt: expect.any(String) });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.fail).not.toHaveBeenCalled();
  });
  it("does not overwrite a run already marked terminal during execution", async () => {
    mocks.getRunById.mockResolvedValueOnce({ status: "running" }).mockResolvedValueOnce({ status: "failed" });
    mocks.execute.mockResolvedValue({ status: "completed", error: null, report: "Article", proposalsQueued: 0, stepsUsed: 1, costNote: null });
    await run();
    expect(mocks.updateRun).toHaveBeenCalledTimes(1);
    expect(mocks.updateRun).toHaveBeenCalledWith("run_1", { status: "running", startedAt: expect.any(String) });
  });
});
