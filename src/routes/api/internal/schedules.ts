import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getAuthMode } from "@/lib/auth-mode";
import { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import { AiVisibilityManagementService } from "@/server/features/ai-visibility/services/AiVisibilityManagementService";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { RankTrackingService } from "@/server/features/rank-tracking/services/RankTrackingService";
import { AppError } from "@/server/lib/errors";

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function assertAgencyToken(request: Request): Response | null {
  // Reusing AGENCY_SCORE_EXPORT_TOKEN is deliberate (one internal-export credential; spec forbade a new token).
  const expected = (
    env as { AGENCY_SCORE_EXPORT_TOKEN?: string }
  ).AGENCY_SCORE_EXPORT_TOKEN?.trim();
  if (!expected) {
    return Response.json(
      { error: "agency_score_export_disabled" },
      { status: 503, headers: NO_STORE },
    );
  }
  const token = extractBearer(request);
  if (!token || !timingSafeEqual(token, expected)) {
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }
  return null;
}

const NO_STORE = { "cache-control": "no-store" } as const;

// cloudflare_access folds every legacy delegated-* org into shared-workspace
// (workspace-merge.ts), so that id is the whole tenant there. local_noauth's
// org is delegated-local-admin. hosted uses per-user organizations, where no
// single org is correct for a deployment-wide token — refuse rather than
// read or write someone else's tenant.
function resolveOrganizationId(): string | null {
  const mode = getAuthMode(env.AUTH_MODE);
  if (mode === "hosted") return null;
  if (mode === "local_noauth") return "delegated-local-admin";
  return "shared-workspace";
}

function unsupportedAuthMode(): Response {
  return Response.json(
    { error: "unsupported_auth_mode" },
    { status: 403, headers: NO_STORE },
  );
}

// "manual" is the pause: the scheduler skips manual configs, the config stays
// visible, and nothing is deleted. Restoring the old interval schedules the
// next run one full interval from now, so there is no catch-up run.
const setScheduleSchema = z.object({
  projectId: z.string().min(1),
  kind: z.enum(["rank_tracker", "ai_visibility"]),
  configId: z.string().min(1),
  scheduleInterval: z.enum(["daily", "weekly", "monthly", "manual"]),
});

async function findOwnedProject(organizationId: string, projectId: string) {
  try {
    return (
      (await ProjectService.getProjectForOrganization(
        organizationId,
        projectId,
      )) ?? null
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

async function listSchedules(projectId: string) {
  const [rankTrackers, aiVisibility] = await Promise.all([
    RankTrackingService.getConfigs(projectId),
    AiVisibilityRepository.getConfigsForProject(projectId),
  ]);
  return {
    rankTrackers: rankTrackers.map((config) => ({
      configId: config.id,
      scheduleInterval: config.scheduleInterval,
      nextCheckAt: config.nextCheckAt,
    })),
    aiVisibility: aiVisibility.map((config) => ({
      configId: config.id,
      scheduleInterval: config.scheduleInterval,
      nextRunAt: config.nextRunAt,
    })),
  };
}

export async function handleGet(request: Request): Promise<Response> {
  const denied = assertAgencyToken(request);
  if (denied) return denied;

  const organizationId = resolveOrganizationId();
  if (organizationId === null) return unsupportedAuthMode();

  const projectId =
    new URL(request.url).searchParams.get("projectId")?.trim() ?? "";
  if (!projectId) {
    return Response.json(
      { error: "invalid_query" },
      { status: 400, headers: NO_STORE },
    );
  }

  const project = await findOwnedProject(organizationId, projectId);
  if (!project) {
    return Response.json(
      { error: "project_not_found" },
      { status: 404, headers: NO_STORE },
    );
  }

  return Response.json(
    { projectId, domain: project.domain, ...(await listSchedules(projectId)) },
    { headers: NO_STORE },
  );
}

export async function handlePost(request: Request): Promise<Response> {
  const denied = assertAgencyToken(request);
  if (denied) return denied;

  const organizationId = resolveOrganizationId();
  if (organizationId === null) return unsupportedAuthMode();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json" },
      { status: 400, headers: NO_STORE },
    );
  }
  const parsed = setScheduleSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_body" },
      { status: 400, headers: NO_STORE },
    );
  }
  const { projectId, kind, configId, scheduleInterval } = parsed.data;

  const project = await findOwnedProject(organizationId, projectId);
  if (!project) {
    return Response.json(
      { error: "project_not_found" },
      { status: 404, headers: NO_STORE },
    );
  }

  const before = await listSchedules(projectId);
  const known = (
    kind === "rank_tracker" ? before.rankTrackers : before.aiVisibility
  ).some((config) => config.configId === configId);
  if (!known) {
    return Response.json(
      { error: "config_not_found" },
      { status: 404, headers: NO_STORE },
    );
  }

  try {
    if (kind === "rank_tracker") {
      await RankTrackingService.updateConfig(configId, projectId, {
        scheduleInterval,
      });
    } else if (scheduleInterval === "daily") {
      return Response.json(
        { error: "invalid_body" },
        { status: 400, headers: NO_STORE },
      );
    } else {
      await AiVisibilityManagementService.updateConfig(configId, projectId, {
        scheduleInterval,
      });
    }
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") {
      return Response.json(
        { error: "config_not_found" },
        { status: 404, headers: NO_STORE },
      );
    }
    throw error;
  }

  return Response.json(
    { projectId, domain: project.domain, ...(await listSchedules(projectId)) },
    { headers: NO_STORE },
  );
}

export const Route = createFileRoute("/api/internal/schedules")({
  server: {
    handlers: {
      GET: ({ request }) => handleGet(request),
      POST: ({ request }) => handlePost(request),
    },
  },
});
