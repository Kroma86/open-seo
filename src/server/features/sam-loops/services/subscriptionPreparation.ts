import { MCP_SCOPE } from "@/lib/oauth-resource";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { isSamLoopProjectAllowed } from "@/shared/sam-loops";
import { SamLoopRepository } from "../repositories/SamLoopRepository";
import { prepareSamLoop } from "./runHeadlessSamLoop";
import { SubscriptionLoopError } from "./subscriptionReceipt";

const HOUSE_TOOLS = new Set([
  "get_audit_issues",
  "get_audit_pages",
  "list_saved_keywords",
  "list_sam_loops",
  "get_sam_loop_runs",
]);

const FREE_TOOLS = new Set([
  "map_links",
  "read_pages",
  "whoami",
  "get_product_info",
  "list_saved_keywords",
  "get_niceseo_ops_status",
  "get_agency_score_inputs",
  "get_agency_otto_page_inputs",
  "list_homegrown_otto_proposals",
  "get_audit_status",
  "get_audit_issues",
  "get_audit_pages",
  "get_rank_tracker",
  "estimate_rank_tracker_cost",
  "get_search_console_performance",
  "inspect_urls",
  "get_google_analytics_organic_landing_pages",
  "get_google_analytics_page_performance",
  "get_google_analytics_key_events",
  "get_search_opportunities",
  "get_google_analytics_organic_overview",
  "get_google_analytics_traffic_acquisition",
  "get_google_analytics_measurement_health",
  "get_google_analytics_ecommerce_performance",
  "get_google_analytics_site_search",
  "get_google_analytics_audience_breakdown",
  "list_sam_loops",
  "get_sam_loop_runs",
  "get_ai_visibility_trend",
  "propose_homegrown_otto_fixes",
]);
export async function prepareSubscriptionLoop(
  projectId: string,
  loopId: string,
  baseUrl: string,
  houseOnly = false,
) {
  const project = await ProjectRepository.getProjectById(projectId);
  const loop = await SamLoopRepository.getLoopById(loopId, projectId);
  if (
    !project ||
    project.archivedAt ||
    !loop?.isEnabled ||
    !isSamLoopProjectAllowed(project)
  )
    throw new SubscriptionLoopError("loop_not_permitted", 403);
  if (houseOnly && project.domain !== "niceseo.ai")
    throw new SubscriptionLoopError("loop_not_house", 403);
  const prepared = await prepareSamLoop({
    project,
    sourceType: loop.sourceType,
    skillName: loop.skillName,
    customPrompt: loop.customPrompt,
    loopName: loop.name,
    authContext: {
      userId: "system",
      userEmail: "system@openseo.so",
      organizationId: project.organizationId,
      clientId: null,
      scopes: [MCP_SCOPE],
      baseUrl,
    },
  });
  if (!("tools" in prepared))
    throw new SubscriptionLoopError("loop_not_ready", 409);
  if (houseOnly && prepared.domain !== "niceseo.ai")
    throw new SubscriptionLoopError("loop_not_house", 403);
  prepared.tools = Object.fromEntries(
    Object.entries(prepared.tools).filter(([name]) =>
      (houseOnly ? HOUSE_TOOLS : FREE_TOOLS).has(name),
    ),
  );
  return { project, loop, prepared };
}
