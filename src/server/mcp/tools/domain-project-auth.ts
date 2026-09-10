import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";
import type { ToolContext } from "@/server/mcp/context";

/**
 * Auth gate for domain-keyed tools (the HomeGrown OTTO queue, ops status).
 * The caller's token carries an organization; the domain must resolve to
 * exactly one unarchived project in THAT organization, by exact domain only.
 * No project → FORBIDDEN (same as project-auth.ts for a foreign projectId).
 * Two projects → CONFLICT from the resolver, surfaced as-is.
 */
export async function requireProjectForDomain(
  toolContext: ToolContext,
  domain: string,
) {
  const organizationId = toolContext.auth.organizationId;
  const project = await ProjectRepository.resolveProjectByDomain({
    domain,
    organizationId,
  });
  if (!project) {
    throw new AppError(
      "FORBIDDEN",
      `no project in this organization has the domain ${domain}`,
    );
  }
  return { organizationId, project };
}
