import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import {
  enqueueHomegrownOttoProposal,
  listHomegrownOttoProposals,
  markHomegrownOttoProposalsPulled,
} from "@/server/features/agency/AgencyOttoProposalsService";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// JSON bodies only carry strings, numbers, booleans, null, arrays and objects.
// Primitives stringify as before; arrays and objects become "" (domain_required).
function stringifyDomain(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return "";
}

function assertAgencyToken(request: Request): Response | null {
  const expected = (
    env as { AGENCY_SCORE_EXPORT_TOKEN?: string }
  ).AGENCY_SCORE_EXPORT_TOKEN?.trim();
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
  const status = url.searchParams.get("status");
  const domain = url.searchParams.get("domain")?.trim();
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 50;
  const proposals = await listHomegrownOttoProposals({
    status: status ?? "pending",
    domain: domain || undefined,
    limit: Number.isFinite(limit) ? limit : 50,
  });
  return Response.json(
    { proposals, count: proposals.length },
    { headers: { "cache-control": "no-store" } },
  );
}

async function handlePost(request: Request): Promise<Response> {
  const denied = assertAgencyToken(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!isRecord(body)) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const record = body;
  if (record.action === "mark_pulled") {
    const ids = Array.isArray(record.ids)
      ? record.ids.filter((id): id is string => typeof id === "string")
      : [];
    const marked = await markHomegrownOttoProposalsPulled(ids);
    return Response.json({ marked });
  }

  try {
    const proposal = await enqueueHomegrownOttoProposal({
      domain: stringifyDomain(record.domain),
      projectId: typeof record.projectId === "string" ? record.projectId : null,
      path: typeof record.path === "string" ? record.path : "/",
      fixes: isRecord(record.fixes) ? record.fixes : {},
      before: isRecord(record.before) ? record.before : {},
      humanReview: Array.isArray(record.humanReview)
        ? record.humanReview.filter((x): x is string => typeof x === "string")
        : [],
      flags: Array.isArray(record.flags)
        ? record.flags.filter((x): x is string => typeof x === "string")
        : [],
      rationale: typeof record.rationale === "string" ? record.rationale : null,
      proposedBy: "api",
    });
    return Response.json({ proposal }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "enqueue_failed",
      },
      { status: 400 },
    );
  }
}

export const Route = createFileRoute("/api/internal/agency-otto-proposals")({
  server: {
    handlers: {
      GET: ({ request }) => handleGet(request),
      POST: ({ request }) => handlePost(request),
    },
  },
});
