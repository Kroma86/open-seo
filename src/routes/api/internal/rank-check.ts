import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { member, user } from "@/db/schema";
import { getAuthMode } from "@/lib/auth-mode";
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

function tenantIsWholeDeployment(): boolean {
  return getAuthMode(env.AUTH_MODE) === "cloudflare_access";
}

function createdAtMs(value: Date | number | string | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.POSITIVE_INFINITY;
}

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

async function resolveActor(organizationId: string) {
  const rows = tenantIsWholeDeployment()
    ? await db
        .select({
          userId: user.id,
          userEmail: user.email,
          createdAt: user.createdAt,
        })
        .from(user)
        .orderBy(asc(user.createdAt), asc(user.id))
    : await db
        .select({
          userId: user.id,
          userEmail: user.email,
          createdAt: member.createdAt,
        })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(eq(member.organizationId, organizationId))
        .orderBy(asc(member.createdAt), asc(user.id));

  const actor = rows
    .filter((row) => (row.userEmail ?? "").trim())
    .toSorted((left, right) => {
      const byCreated = createdAtMs(left.createdAt) - createdAtMs(right.createdAt);
      if (byCreated !== 0) return byCreated;
      return left.userId.localeCompare(right.userId);
    })[0];

  if (!actor) return null;
  return { userId: actor.userId, userEmail: (actor.userEmail ?? "").trim() };
}

const triggerSchema = z.object({
  projectId: z.string().min(1),
  configId: z.string().uuid(),
  maxCostCredits: z.number().int().positive(),
});

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

  const parsed = triggerSchema.safeParse(body);
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

  const actor = await resolveActor(organizationId);
  if (!actor) {
    return Response.json(
      { error: "no_actor_available" },
      { status: 409, headers: NO_STORE },
    );
  }

  try {
    const result = await RankTrackingService.triggerCheck({
      configId: parsed.data.configId,
      projectId: parsed.data.projectId,
      maxCostCredits: parsed.data.maxCostCredits,
      billingCustomer: {
        organizationId,
        userEmail: actor.userEmail,
        userId: actor.userId,
        projectId: parsed.data.projectId,
      },
    });

    if (!result.ok) {
      return Response.json(
        {
          started: false,
          reason: result.reason,
          blockingRunId: result.blockingRunId,
        },
        { status: 409, headers: NO_STORE },
      );
    }

    return Response.json(
      { started: true, runId: result.runId },
      { status: 202, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
      return Response.json(
        { error: "validation_failed", detail: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    return Response.json(
      { error: "rank_check_start_failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}

export const Route = createFileRoute("/api/internal/rank-check")({
  server: {
    handlers: {
      POST: ({ request }) => handlePost(request),
    },
  },
});
