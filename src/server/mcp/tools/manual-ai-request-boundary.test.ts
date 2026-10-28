import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeToolContext, textContent } from "./tool-test-support";
import { runAiVisibilityCheckTool } from "./run-ai-visibility-check";
import { triggerAiVisibilityCheck } from "@/serverFunctions/ai-visibility";

const projectId = "11111111-1111-4111-8111-111111111111";
const configId = "22222222-2222-4222-8222-222222222222";
const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  engine: vi.fn(),
  telemetry: vi.fn(),
  project: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock(
  "@/server/features/ai-visibility/services/manualAiVisibilityQueue",
  () => ({ enqueueManualAiVisibilityCheck: mocks.enqueue }),
);
vi.mock(
  "@/server/features/ai-visibility/services/runAiVisibilityCheck",
  () => ({ runAiVisibilityCheck: mocks.engine }),
);
vi.mock(
  "@/server/features/ai-visibility/services/AiVisibilityManagementService",
  () => ({ AiVisibilityManagementService: {} }),
);
vi.mock("@/server/features/ai-visibility/services/aiVisibilityResults", () => ({
  getLatestResults: vi.fn(),
  getTrend: vi.fn(),
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { getProjectForOrganization: mocks.project },
}));
vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: mocks.telemetry,
}));
vi.mock("@/serverFunctions/middleware", () => ({ requireProjectContext: [] }));
// This boundary test deliberately replaces middleware. Project authorization
// remains covered by the real MCP auth tests; no provider can run here.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      validator: () => builder,
      handler: (callback: (args: any) => Promise<unknown>) => (input: any) =>
        callback({
          data: input.data,
          context: {
            projectId: "11111111-1111-4111-8111-111111111111",
            organizationId: "org_1",
            userId: "user_1",
            userEmail: "operator@example.test",
          },
        }),
    };
    return builder;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enqueue.mockResolvedValue({
    ok: true,
    runId: "queued1",
    outcome: "queued",
  });
  mocks.engine.mockImplementation(() => new Promise(() => {}));
  mocks.telemetry.mockResolvedValue(undefined);
  mocks.project.mockResolvedValue({
    id: projectId,
    domain: "example.test",
    locationCode: 2124,
    languageCode: "en",
  });
});

describe("manual AI request lifetime", () => {
  it("MCP returns queued even if the old in-request engine could never finish", async () => {
    const result = await Promise.race([
      runAiVisibilityCheckTool.handler(
        { projectId, configId },
        makeToolContext(),
      ),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 100),
      ),
    ]);
    expect(result).not.toBe("timeout");
    if (result === "timeout") throw new Error("request awaited engine");
    expect(textContent(result)).toContain("queued");
    expect(textContent(result)).not.toContain("completed");
    expect(mocks.engine).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });
  it("page action also returns durable acceptance without awaiting the engine", async () => {
    const result = await Promise.race([
      triggerAiVisibilityCheck({ data: { projectId, configId } }),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 100),
      ),
    ]);
    expect(result).toMatchObject({
      ok: true,
      runId: "queued1",
      outcome: "queued",
    });
    expect(mocks.engine).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });
});
