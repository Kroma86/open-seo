import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { getAgencyLoopReports } from "@/server/features/agency/AgencyLoopReportsService";

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

// Lexical compare against finishedAt — callers must use the same textual format
// the DB stores (millisecond UTC ISO). This gate keeps malformed cursors from
// silently returning wrong windows.
const SINCE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export async function handleGet(request: Request): Promise<Response> {
  // Reusing AGENCY_SCORE_EXPORT_TOKEN is deliberate (one internal-export credential; spec forbade a new token).
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

  const url = new URL(request.url);
  const since = url.searchParams.get("since")?.trim();
  if (!since) {
    return Response.json(
      {
        error: "since_required",
        hint: "GET ?since=2026-08-31T00:00:00Z",
      },
      { status: 400 },
    );
  }
  if (!SINCE_RE.test(since)) {
    return Response.json(
      {
        error: "invalid_since",
        hint: "ISO 8601 UTC, e.g. 2026-08-31T00:00:00.000Z",
      },
      { status: 400 },
    );
  }

  const limitRaw = url.searchParams.get("limit");
  let limit = 50;
  if (limitRaw != null && limitRaw !== "") {
    const parsed = Number(limitRaw);
    if (!Number.isFinite(parsed)) {
      return Response.json({ error: "invalid_limit" }, { status: 400 });
    }
    limit = parsed;
  }

  const data = await getAgencyLoopReports(since, limit);
  return Response.json(data, {
    headers: {
      "cache-control": "no-store",
    },
  });
}

export const Route = createFileRoute("/api/internal/agency-loop-reports")({
  server: {
    handlers: {
      GET: ({ request }) => handleGet(request),
    },
  },
});
