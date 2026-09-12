import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { AgencyOpsArtifactsService } from "@/server/features/agency/AgencyOpsArtifactsService";

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

  try {
    const result = await AgencyOpsArtifactsService.ingest(
      body as Record<string, unknown>,
    );
    if (result.deduped) {
      return Response.json(
        { id: result.id, deduped: true },
        { status: 200, headers: NO_STORE },
      );
    }
    return Response.json({ id: result.id }, { status: 201, headers: NO_STORE });
  } catch (error) {
    // Only the contract's validation errors map to 400. Anything else (DB
    // unavailable, repository race) is a retryable server failure — a 400
    // here would make the box-side pusher drop the artifact permanently.
    const message = error instanceof Error ? error.message : "";
    if (/^[a-zA-Z]+_invalid$/.test(message)) {
      return Response.json({ error: message }, { status: 400, headers: NO_STORE });
    }
    return Response.json(
      { error: "ingest_failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}

export const Route = createFileRoute("/api/internal/agency-ops-artifacts")({
  server: {
    handlers: {
      POST: ({ request }) => handlePost(request),
    },
  },
});
