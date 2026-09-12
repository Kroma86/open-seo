import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";

const mocks = vi.hoisted(() => ({
  setLoopsEnabled: vi.fn(),
}));

vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    setLoopsEnabled: (...args: unknown[]) => mocks.setLoopsEnabled(...args),
  },
}));

vi.mock("@/server/features/projects/services/projects", () => ({
  archiveProject: vi.fn(),
  createProject: vi.fn(),
  getProjectForOrganization: vi.fn(),
  listArchivedProjects: vi.fn(),
  listProjects: vi.fn(),
  listProjectsEnsuringOne: vi.fn(),
  restoreProject: vi.fn(),
  setProjectDomain: vi.fn(),
  setProjectMarket: vi.fn(),
  updateProject: vi.fn(),
}));

import { setLoopsEnabled } from "./ProjectService";

const ROW = {
  id: "project_1",
  organizationId: "org_1",
  domain: "example.com",
  loopsEnabled: true,
};

describe("ProjectService.setLoopsEnabled", () => {
  beforeEach(() => {
    mocks.setLoopsEnabled.mockResolvedValue(ROW);
  });

  it("forwards organizationId to the repository", async () => {
    await expect(setLoopsEnabled("org_1", "project_1", true)).resolves.toEqual(
      ROW,
    );
    expect(mocks.setLoopsEnabled).toHaveBeenCalledWith(
      "project_1",
      "org_1",
      true,
    );
  });

  it("throws NOT_FOUND when the repository updates zero rows (archived or missing)", async () => {
    mocks.setLoopsEnabled.mockResolvedValue(null);
    await expect(setLoopsEnabled("org_1", "project_1", true)).rejects.toEqual(
      new AppError("NOT_FOUND"),
    );
  });
});
