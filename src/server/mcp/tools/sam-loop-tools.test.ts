import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { updateSamLoopTool } from "./sam-loop-tools";
import {
  makeToolContext,
  textContent,
  validateAsClientWould,
} from "./tool-test-support";
import { filterLoopTools } from "@/server/features/sam-loops/services/loopToolFilter";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  updateSamLoop: vi.fn(),
  triggerSamLoop: vi.fn(),
  setLoopsEnabled: vi.fn(),
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
    setLoopsEnabled: mocks.setLoopsEnabled,
  },
}));
vi.mock("@/server/features/sam-loops/services/SamLoopService", () => ({
  SamLoopService: {
    updateSamLoop: mocks.updateSamLoop,
    triggerSamLoop: mocks.triggerSamLoop,
  },
}));
const projectId = "11111111-1111-4111-8111-111111111111";
const loopId = "22222222-2222-4222-8222-222222222222";
const context = makeToolContext();
const saved = {
  id: loopId,
  projectId,
  name: "Synthetic loop",
  cadence: "weekly",
  isEnabled: false,
  nextRunAt: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getProjectForOrganization.mockResolvedValue({
    id: projectId,
    domain: "example.test",
    loopsEnabled: false,
  });
  mocks.updateSamLoop.mockImplementation(async (input) => ({
    ...saved,
    ...input,
  }));
});

describe("update_sam_loop", () => {
  it("publishes a client-readable input schema with strict schedule fields", () => {
    expect(
      validateAsClientWould(updateSamLoopTool.config.inputSchema, {
        projectId,
        loopId,
        isEnabled: false,
        cadence: "weekly",
      }).valid,
    ).toBe(true);
    expect(
      validateAsClientWould(updateSamLoopTool.config.inputSchema, {
        projectId,
        loopId,
        isEnabled: true,
        customPrompt: "extra",
      }).valid,
    ).toBe(false);
  });
  it.each([true, false])(
    "saves isEnabled=%s without starting work or changing project permission",
    async (isEnabled) => {
      const result = await updateSamLoopTool.handler(
        { projectId, loopId, isEnabled },
        context,
      );
      expect(mocks.getProjectForOrganization).toHaveBeenCalledWith(
        "org_123",
        projectId,
      );
      expect(mocks.updateSamLoop).toHaveBeenCalledExactlyOnceWith({
        projectId,
        loopId,
        isEnabled,
      });
      expect(mocks.triggerSamLoop).not.toHaveBeenCalled();
      expect(mocks.setLoopsEnabled).not.toHaveBeenCalled();
      expect(textContent(result)).toContain(
        isEnabled ? "on, weekly" : "off, weekly",
      );
      expect(textContent(result)).toContain("No run was started");
      expect(
        validateAsClientWould(
          updateSamLoopTool.config.outputSchema,
          result.structuredContent,
        ).valid,
      ).toBe(true);
    },
  );
  it.each(["daily", "weekly", "monthly"] as const)(
    "accepts %s without overwriting enabled state",
    async (cadence) => {
      const result = await updateSamLoopTool.handler(
        { projectId, loopId, cadence },
        context,
      );
      expect(mocks.updateSamLoop).toHaveBeenCalledExactlyOnceWith({
        projectId,
        loopId,
        cadence,
      });
      expect(result.structuredContent).toMatchObject({
        loop: { cadence, isEnabled: false },
      });
    },
  );
  it("accepts both schedule controls together", async () => {
    await updateSamLoopTool.handler(
      { projectId, loopId, cadence: "monthly", isEnabled: false },
      context,
    );
    expect(mocks.updateSamLoop).toHaveBeenCalledExactlyOnceWith({
      projectId,
      loopId,
      cadence: "monthly",
      isEnabled: false,
    });
  });
  it.each([
    {},
    { cadence: "hourly" },
    { isEnabled: "false" },
    { isEnabled: true, customPrompt: "replacement" },
    { cadence: "daily", name: "replacement" },
    { isEnabled: true, loopsEnabled: true },
    { isEnabled: true, nextRunAt: "2026-10-15T00:00:00.000Z" },
  ])(
    "refuses invalid or extra controls before an update: %j",
    async (fields) => {
      await expect(
        updateSamLoopTool.handler(
          { projectId, loopId, ...fields } as never,
          context,
        ),
      ).rejects.toThrow();
      expect(mocks.updateSamLoop).not.toHaveBeenCalled();
    },
  );
  it("refuses a project outside the caller organization", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);
    await expect(
      updateSamLoopTool.handler(
        { projectId, loopId, isEnabled: true },
        context,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.updateSamLoop).not.toHaveBeenCalled();
  });
  it("refuses an archived project", async () => {
    // The real repository excludes archived rows; the service throws NOT_FOUND.
    mocks.getProjectForOrganization.mockRejectedValue(
      new AppError("NOT_FOUND"),
    );
    await expect(
      updateSamLoopTool.handler(
        { projectId, loopId, cadence: "daily" },
        context,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.updateSamLoop).not.toHaveBeenCalled();
  });
  it("preserves the service's refusal of a missing or foreign-project loop", async () => {
    mocks.updateSamLoop.mockRejectedValue(
      new AppError("NOT_FOUND", "Loop not found"),
    );
    await expect(
      updateSamLoopTool.handler(
        { projectId, loopId, isEnabled: false },
        context,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.updateSamLoop).toHaveBeenCalledWith({
      projectId,
      loopId,
      isEnabled: false,
    });
  });
  it("stays unavailable to autonomous loops", () => {
    const entry = { inputSchema: z.object({}), execute: vi.fn() };
    const tools = filterLoopTools({
      update_sam_loop: entry,
      list_sam_loops: entry,
    });
    expect(tools).not.toHaveProperty("update_sam_loop");
    expect(tools).toHaveProperty("list_sam_loops");
    expect(updateSamLoopTool.config.annotations.readOnlyHint).toBe(false);
  });
});
