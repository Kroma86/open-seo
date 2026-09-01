import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getAuthMode } from "@/lib/auth-mode";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { AppError } from "@/server/lib/errors";
import { isSamLoopDomainAllowed } from "@/shared/sam-loops";

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

async function findOwnedProject(organizationId: string, projectId: string) {
  return (
    (await ProjectRepository.getProjectForOrganization(
      projectId,
      organizationId,
    )) ?? null
  );
}

const setLoopsEnabledSchema = z.object({
  projectId: z.string().min(1),
  enabled: z.boolean(),
});

function toPayload(project: {
  id: string;
  domain: string | null;
  loopsEnabled: boolean;
}) {
  return {
    projectId: project.id,
    domain: project.domain,
    loopsEnabled: project.loopsEnabled,
    houseDomain: isSamLoopDomainAllowed(project.domain),
  };
}

export async function handleGet(request: Request): Promise<Response> {
  const denied = assertAgencyToken(request);
  if (denied) return denied;

  const organizationId = resolveOrganizationId();
  if (organizationId === null) return unsupportedAuthMode();

  const projectId = new URL(request.url).searchParams.get("projectId")?.trim() ?? "";
  if (!projectId) {
    return Response.json({ error: "invalid_query" }, { status: 400, headers: NO_STORE });
  }

  const owned = await findOwnedProject(organizationId, projectId);
  if (!owned) {
    return Response.json(
      { error: "project_not_found" },
      { status: 404, headers: NO_STORE },
    );
  }

  return Response.json(toPayload(owned), { headers: NO_STORE });
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

  const parsed = setLoopsEnabledSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  }

  const owned = await findOwnedProject(organizationId, parsed.data.projectId);
  if (!owned) {
    return Response.json(
      { error: "project_not_found" },
      { status: 404, headers: NO_STORE },
    );
  }
  if (parsed.data.enabled && !owned.domain?.trim()) {
    return Response.json(
      { error: "project_has_no_domain" },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    // Disabling never deletes loops (the cron simply claims-and-skips them again).
    const project = await ProjectService.setLoopsEnabled(
      organizationId,
      parsed.data.projectId,
      parsed.data.enabled,
    );
    return Response.json(toPayload(project), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") {
      return Response.json(
        { error: "project_not_found" },
        { status: 404, headers: NO_STORE },
      );
    }
    throw error;
  }
}

export const Route = createFileRoute("/api/internal/loops-enabled")({
  server: {
    handlers: {
      GET: ({ request }) => handleGet(request),
      POST: ({ request }) => handlePost(request),
    },
  },
});
