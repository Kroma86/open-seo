import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { SamLoopService } from "@/server/features/sam-loops/services/SamLoopService";

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
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }
  return null;
}

const NO_STORE = { "cache-control": "no-store" } as const;

function readNames(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function handlePost(request: Request): Promise<Response> {
  const denied = assertAgencyToken(request);
  if (denied) return denied;

  let body: unknown = {};
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "invalid_json" },
        { status: 400, headers: NO_STORE },
      );
    }
  }
  if (!body || typeof body !== "object") {
    return Response.json(
      { error: "invalid_body" },
      { status: 400, headers: NO_STORE },
    );
  }

  const record = body as Record<string, unknown>;
  const url = new URL(request.url);
  const domainRaw =
    (typeof record.domain === "string" ? record.domain : null) ??
    url.searchParams.get("domain");
  const domain = domainRaw?.trim() ?? "";
  if (!domain) {
    return Response.json(
      { error: "domain_required", hint: 'POST {"domain":"niceseo.ai"}' },
      { status: 400, headers: NO_STORE },
    );
  }

  const names = readNames(record.names) ?? readNames(url.searchParams.get("names"));

  const result = await SamLoopService.triggerSamLoopsForDomain({
    domain,
    names,
  });
  if (!result.ok) {
    if (result.reason === "ambiguous_project_domain") {
      return Response.json(
        {
          error: "ambiguous_project_domain",
          count: result.count,
        },
        { status: 409, headers: NO_STORE },
      );
    }
    const status =
      result.reason === "daily_cap"
        ? 429
        : result.reason === "domain_not_allowed"
          ? 403
          : 404;
    return Response.json(
      {
        error: result.reason,
        ...(result.reason === "domain_not_allowed"
          ? {
              hint: "enable loops for this project via POST /api/internal/loops-enabled",
            }
          : {}),
      },
      { status, headers: NO_STORE },
    );
  }
  return Response.json(result, { status: 200, headers: NO_STORE });
}

export const Route = createFileRoute("/api/internal/trigger-sam-loops")({
  server: {
    handlers: {
      POST: ({ request }) => handlePost(request),
    },
  },
});
