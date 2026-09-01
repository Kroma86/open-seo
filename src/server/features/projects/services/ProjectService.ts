import {
  archiveProject,
  createProject,
  getProjectForOrganization,
  listArchivedProjects,
  listProjects,
  listProjectsEnsuringOne,
  restoreProject,
  setProjectDomain,
  setProjectMarket,
  updateProject,
} from "@/server/features/projects/services/projects";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";

export async function setLoopsEnabled(
  organizationId: string,
  projectId: string,
  enabled: boolean,
) {
  const updated = await ProjectRepository.setLoopsEnabled(
    projectId,
    organizationId,
    enabled,
  );
  if (!updated) {
    throw new AppError("NOT_FOUND");
  }
  return updated;
}

export const ProjectService = {
  listProjects,
  listProjectsEnsuringOne,
  createProject,
  updateProject,
  setProjectDomain,
  setProjectMarket,
  archiveProject,
  restoreProject,
  listArchivedProjects,
  getProjectForOrganization,
  setLoopsEnabled,
} as const;
