import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import {
  getAgencyMonthlyExportByDomain,
  getAgencyMonthlyExportIndex,
} from "@/server/features/agency/AgencyMonthlyExportService";

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

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const NO_STORE = { "cache-control": "no-store" } as const;

function parseMonth(raw: string | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const match = MONTH_RE.exec(trimmed);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return trimmed;
}

export async function handleGet(request: Request): Promise<Response> {
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

  const url = new URL(request.url);
  const month = parseMonth(url.searchParams.get("month"));
  if (!month) {
    return Response.json(
      { error: "invalid_month", hint: "YYYY-MM" },
      { status: 400, headers: NO_STORE },
    );
  }

  const domain = url.searchParams.get("domain")?.trim();
  const index = url.searchParams.get("index")?.trim();
  const hasDomain = Boolean(domain);
  const hasIndex = index === "1";

  if (hasDomain === hasIndex) {
    return Response.json(
      { error: "domain_or_index_required" },
      { status: 400, headers: NO_STORE },
    );
  }

  if (hasDomain) {
    const data = await getAgencyMonthlyExportByDomain(domain!, month);
    if (!data) {
      return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    }
    return Response.json(data, { headers: NO_STORE });
  }

  const data = await getAgencyMonthlyExportIndex(month);
  if (!data) {
    return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }
  return Response.json(data, { headers: NO_STORE });
}

export const Route = createFileRoute("/api/internal/agency-monthly-export")({
  server: {
    handlers: {
      GET: ({ request }) => handleGet(request),
    },
  },
});
