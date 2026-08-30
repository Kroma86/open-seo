import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { getAgencyOttoPageInputsGlobal } from "@/server/features/agency/AgencyOttoPageInputsService";

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
      { status: 503 },
    );
  }
  const token = extractBearer(request);
  if (!token || !timingSafeEqual(token, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

async function handleGet(request: Request): Promise<Response> {
  const denied = assertAgencyToken(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const domain = url.searchParams.get("domain")?.trim();
  if (!domain) {
    return Response.json(
      { error: "domain_required", hint: "GET ?domain=example.com" },
      { status: 400 },
    );
  }
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  const data = await getAgencyOttoPageInputsGlobal(domain);
  if (limit && Number.isFinite(limit)) {
    data.pages = data.pages.slice(0, Math.min(Math.max(limit, 1), 100));
  }
  return Response.json(data, {
    headers: { "cache-control": "no-store" },
  });
}

export const Route = createFileRoute("/api/internal/agency-otto-page-inputs")({
  server: {
    handlers: {
      GET: ({ request }) => handleGet(request),
    },
  },
});
