/**
 * db-backed PortfolioVisibilitySource — the narrowly scoped adapter that
 * wires the pure sweep (portfolioVisibilitySweep.ts) to existing read
 * services. Composition only: no new queries, no writes, no endpoints.
 *
 * Read-only and free by construction: it calls ProjectRepository.listProjects,
 * AiVisibilityManagementService.getConfigs, and getLatestResults — the same
 * reads behind list_projects, manage_ai_visibility_tracking(list), and
 * get_ai_visibility_trend. It never calls runAiVisibilityCheck, explorePrompt,
 * or getBrandLookup, so it can never trigger a paid measurement.
 *
 * Not wired to any route, cron, or MCP tool — exposing it is a
 * runtime-operator decision. Fixture-tested logic lives in
 * portfolioVisibilitySweep.ts; this file is exercised by typecheck only
 * (needs a live database).
 */
import { AiVisibilityManagementService } from "@/server/features/ai-visibility/services/AiVisibilityManagementService";
import { getLatestResults } from "@/server/features/ai-visibility/services/aiVisibilityResults";
import type {
  PortfolioSweepProject,
  PortfolioTrackingConfig,
  PortfolioVisibilitySource,
} from "@/server/features/ai-visibility/services/portfolioVisibilitySweep";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import type { AiVisibilityLatestResults } from "@/types/schemas/ai-visibility";

export function createPortfolioVisibilitySource(
  organizationId: string,
): PortfolioVisibilitySource {
  return {
    async listProjects(): Promise<PortfolioSweepProject[]> {
      const rows = await ProjectRepository.listProjects(organizationId);
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        domain: row.domain,
        repairLoopEnabled: row.loopsEnabled,
      }));
    },

    async listTrackingConfigs(
      projectId: string,
    ): Promise<PortfolioTrackingConfig[]> {
      const configs = await AiVisibilityManagementService.getConfigs(projectId);
      return configs.map((config) => ({
        id: config.id,
        brand: config.brand,
        isActive: config.isActive,
        scheduleInterval: config.scheduleInterval,
        promptSetVersion: config.promptSetVersion,
        createdAt: config.createdAt,
        prompts: config.prompts.map((prompt) => ({
          id: prompt.id,
          isActive: prompt.isActive,
        })),
      }));
    },

    async getAiVisibilityTrend(
      projectId: string,
      configId: string,
    ): Promise<AiVisibilityLatestResults> {
      // The `latest` block of get_ai_visibility_trend's structured content.
      // Stored runs only — never starts a measurement.
      return getLatestResults(projectId, configId);
    },
  };
}
