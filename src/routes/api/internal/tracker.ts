import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getAuthMode } from "@/lib/auth-mode";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { RankTrackingService } from "@/server/features/rank-tracking/services/RankTrackingService";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";
import { AppError } from "@/server/lib/errors";
import { MAX_TRACKED_KEYWORD_LENGTH } from "@/shared/rank-tracking";
import {
  comparePeriodSchema,
  type RankTrackingConfig,
} from "@/types/schemas/rank-tracking";

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
  const expected = (env as { AGENCY_SCORE_EXPORT_TOKEN?: string })
    .AGENCY_SCORE_EXPORT_TOKEN?.trim();
  if (!expected) {
    return Response.json(
      { error: "agency_score_export_disabled" },
      { status: 503, headers: NO_STORE },
    );
  }
  const token = extractBearer(request);
  if (!token || !timingSafeEqual(token, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
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

const seedKeywordsSchema = z.object({
  projectId: z.string().min(1),
  keywords: z
    .array(
      z.string().trim().min(1).max(MAX_TRACKED_KEYWORD_LENGTH),
    )
    .min(1)
    .max(100),
  maxEstimatedScheduledCheckCredits: z.number().finite().positive(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(1).max(10).optional(),
  locationName: z.string().min(1).max(200).optional(),
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

function resolveConfig(
  configs: RankTrackingConfig[],
  configId: string,
): RankTrackingConfig | null | undefined {
  if (configId) {
    return configs.find((config) => config.id === configId);
  }
  if (configs.length === 1) return configs[0];
  return null;
}

export async function handleGet(request: Request): Promise<Response> {
  const denied = assertAgencyToken(request);
  if (denied) return denied;

  const organizationId = resolveOrganizationId();
  if (organizationId === null) return unsupportedAuthMode();

  const params = new URL(request.url).searchParams;
  const projectId = params.get("projectId")?.trim() ?? "";
  const rawPeriod = params.get("comparePeriod");
  const comparePeriod = rawPeriod == null ? "7d" : rawPeriod.trim();
  if (!projectId || !comparePeriodSchema.safeParse(comparePeriod).success) {
    return Response.json({ error: "invalid_query" }, { status: 400, headers: NO_STORE });
  }
  const parsedPeriod = comparePeriodSchema.parse(comparePeriod);
  const configId = params.get("configId")?.trim() ?? "";

  const project = await findOwnedProject(organizationId, projectId);
  if (!project) {
    return Response.json(
      { error: "project_not_found" },
      { status: 404, headers: NO_STORE },
    );
  }

  const configs = await RankTrackingService.getConfigs(projectId);
  if (configId && !configs.some((config) => config.id === configId)) {
    return Response.json(
      { error: "config_not_found" },
      { status: 404, headers: NO_STORE },
    );
  }

  const config = resolveConfig(configs, configId);
  if (!config) {
    return Response.json({ configs, tracker: null }, { headers: NO_STORE });
  }

  // getTracker does not take comparePeriod; assemble the same { config, results } shape.
  const results = await getLatestResults(config.id, projectId, parsedPeriod);
  return Response.json(
    { configs, tracker: { config, results } },
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
    return Response.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  }

  const parsed = seedKeywordsSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  }

  const project = await findOwnedProject(organizationId, parsed.data.projectId);
  if (!project) {
    return Response.json(
      { error: "project_not_found" },
      { status: 404, headers: NO_STORE },
    );
  }

  try {
    const configs = await RankTrackingService.getConfigs(parsed.data.projectId);
    let configId: string;
    if (configs.length === 1) {
      // Seeding a scheduled tracker enrolls the new keywords in recurring paid
      // checks — this unattended endpoint only ever touches manual trackers.
      if (configs[0].scheduleInterval !== "manual") {
        return Response.json(
          {
            error: "config_schedule_not_manual",
            detail: configs[0].scheduleInterval,
          },
          { status: 409, headers: NO_STORE },
        );
      }
      configId = configs[0].id;
    } else if (configs.length > 1) {
      return Response.json(
        {
          error: "multiple_configs",
          detail: configs.map((config) => config.id),
        },
        { status: 409, headers: NO_STORE },
      );
    } else {
      if (!project.domain) {
        return Response.json(
          { error: "validation_failed", detail: "Project has no domain" },
          { status: 400, headers: NO_STORE },
        );
      }
      const created = await RankTrackingService.createConfig({
        projectId: parsed.data.projectId,
        projectMarket: {
          locationCode: project.locationCode,
          languageCode: project.languageCode,
        },
        domain: project.domain,
        locationCode: parsed.data.locationCode,
        languageCode: parsed.data.languageCode,
        locationName: parsed.data.locationName,
        serpDepth: 40,
        scheduleInterval: "manual",
      });
      configId = created.id;
    }

    const seeded = await RankTrackingService.addKeywords(
      configId,
      parsed.data.projectId,
      parsed.data.keywords,
      {
        kind: "credit_ceiling",
        maxEstimatedScheduledCheckCredits:
          parsed.data.maxEstimatedScheduledCheckCredits,
      },
    );

    return Response.json(
      {
        configId,
        added: seeded.added,
        addedIds: seeded.addedIds,
        ...(seeded.scheduledEstimate
          ? { scheduledEstimate: seeded.scheduledEstimate }
          : {}),
      },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
      return Response.json(
        { error: "validation_failed", detail: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    return Response.json({ error: "seed_failed" }, { status: 500, headers: NO_STORE });
  }
}

export const Route = createFileRoute("/api/internal/tracker")({
  server: {
    handlers: {
      GET: ({ request }) => handleGet(request),
      POST: ({ request }) => handlePost(request),
    },
  },
});
