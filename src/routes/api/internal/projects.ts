import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { getAuthMode } from "@/lib/auth-mode";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { AppError } from "@/server/lib/errors";
import { createProjectSchema } from "@/types/schemas/projects";

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

const LIST_CAP = 1000;

function toProjectPayload(project: {
  id: string;
  name: string;
  domain: string | null;
  locationCode: number;
  languageCode: string;
}) {
  return {
    id: project.id,
    name: project.name,
    domain: project.domain,
    locationCode: project.locationCode,
    languageCode: project.languageCode,
  };
}

export async function handleGet(request: Request): Promise<Response> {
  const denied = assertAgencyToken(request);
  if (denied) return denied;

  const organizationId = resolveOrganizationId();
  if (organizationId === null) return unsupportedAuthMode();

  const domainFilter = new URL(request.url).searchParams.get("domain")?.trim() ?? "";
  const projects = await ProjectService.listProjects(organizationId);
  const matched = domainFilter
    ? projects.filter(
        (project) =>
          project.domain != null &&
          project.domain.toLowerCase() === domainFilter.toLowerCase(),
      )
    : projects;
  const truncated = matched.length > LIST_CAP;

  return Response.json(
    {
      projects: matched.slice(0, LIST_CAP).map(toProjectPayload),
      ...(truncated ? { truncated: true } : {}),
    },
    { headers: NO_STORE },
  );
}

export async function handlePost(request: Request): Promise<Response> {
  const denied = assertAgencyToken(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  }

  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  }

  const organizationId = resolveOrganizationId();
  if (organizationId === null) return unsupportedAuthMode();

  try {
    const project = await ProjectService.createProject(
      organizationId,
      parsed.data,
    );
    return Response.json(
      { project: toProjectPayload(project) },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
      return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
    }
    return Response.json(
      { error: "create_failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}

export const Route = createFileRoute("/api/internal/projects")({
  server: {
    handlers: {
      GET: ({ request }) => handleGet(request),
      POST: ({ request }) => handlePost(request),
    },
  },
});
