import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { account, member, user } from "@/db/schema";
import { getAuthMode } from "@/lib/auth-mode";
import { Ga4Service } from "@/server/features/ga4/services/Ga4Service";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
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

async function resolveGrantHolders(organizationId: string, providerId: string) {
  // Workspace-merge moved projects onto shared-workspace; member rows did not follow.
  // Email is deliberately not required: holders are identified by userId + provider grant.
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

  const members = rows.toSorted((left, right) => {
    const byCreated = createdAtMs(left.createdAt) - createdAtMs(right.createdAt);
    if (byCreated !== 0) return byCreated;
    return left.userId.localeCompare(right.userId);
  });

  if (members.length === 0) return [];

  const grants = await db
    .select({
      userId: account.userId,
      accountId: account.accountId,
      createdAt: account.createdAt,
    })
    .from(account)
    .where(
      and(
        eq(account.providerId, providerId),
        inArray(
          account.userId,
          members.map((row) => row.userId),
        ),
      ),
    )
    .orderBy(asc(account.createdAt));

  const holders: { userId: string; accountIds: string[] }[] = [];
  for (const candidate of members) {
    const userGrants = grants
      .filter((grant) => grant.userId === candidate.userId)
      .toSorted(
        (left, right) => createdAtMs(left.createdAt) - createdAtMs(right.createdAt),
      );
    if (userGrants.length === 0) continue;
    holders.push({
      userId: candidate.userId,
      accountIds: userGrants.map((grant) => grant.accountId),
    });
  }

  return holders;
}

const postBodySchema = z.object({
  projectId: z.string().trim().min(1),
  propertyId: z
    .string()
    .trim()
    .regex(/^properties\/\d+$/)
    .optional(),
});

type VisibleProperty = {
  accountId: string;
  propertyId: string;
  displayName: string;
};

type Ga4Candidate = {
  propertyId: string;
  displayName: string;
};

function normalizeProjectDomain(raw: string): string {
  let domain = raw.trim().toLowerCase();
  if (domain.startsWith("https://")) {
    domain = domain.slice("https://".length);
  } else if (domain.startsWith("http://")) {
    domain = domain.slice("http://".length);
  }
  const slashIndex = domain.indexOf("/");
  if (slashIndex !== -1) {
    domain = domain.slice(0, slashIndex);
  }
  const portIndex = domain.lastIndexOf(":");
  if (portIndex !== -1) {
    domain = domain.slice(0, portIndex);
  }
  if (domain.startsWith("www.")) {
    domain = domain.slice(4);
  }
  return domain;
}

function ga4DisplayNameMatches(displayName: string, domain: string): boolean {
  const display = displayName.trim().toLowerCase();
  const normalizedDomain = domain.trim().toLowerCase();
  if (display === normalizedDomain) return true;
  if (display.startsWith("www.") && display.slice(4) === normalizedDomain) {
    return true;
  }
  if (display === `${normalizedDomain} - ga4`) return true;
  if (display === `${normalizedDomain} (ga4)`) return true;
  for (const scheme of ["https://", "http://"] as const) {
    const prefix = `${scheme}${normalizedDomain}`;
    if (display === prefix) return true;
    if (display.startsWith(prefix) && display.length > prefix.length) {
      const next = display[prefix.length];
      if (next === "/" || next === "?" || next === "#" || next === " ") {
        return true;
      }
    }
  }
  return false;
}

function flattenVisibleProperties(
  listed: Awaited<
    ReturnType<typeof Ga4Service.listPropertiesForUserWithGrantStatus>
  >,
): VisibleProperty[] {
  const visible: VisibleProperty[] = [];
  for (const listedAccount of listed.accounts) {
    if (listedAccount.requiresReconnect || listedAccount.propertiesUnavailable) {
      continue;
    }
    for (const property of listedAccount.properties) {
      visible.push({
        accountId: listedAccount.accountId,
        propertyId: property.propertyId,
        displayName: property.displayName,
      });
    }
  }
  return visible;
}

function orderVisibleByAccountIds(
  visible: VisibleProperty[],
  accountIds: string[],
): VisibleProperty[] {
  const rank = new Map(accountIds.map((id, index) => [id, index]));
  return visible.toSorted((left, right) => {
    const leftRank = rank.get(left.accountId) ?? Number.POSITIVE_INFINITY;
    const rightRank = rank.get(right.accountId) ?? Number.POSITIVE_INFINITY;
    return leftRank - rightRank;
  });
}

function toCandidates(properties: VisibleProperty[]): Ga4Candidate[] {
  return properties.slice(0, 20).map((property) => ({
    propertyId: property.propertyId,
    displayName: property.displayName,
  }));
}

function propertyNotVisible(
  reason: "no_grant" | "no_match" | "not_visible" | "service_rejected",
  candidates: Ga4Candidate[],
): Response {
  return Response.json(
    { error: "property_not_visible", reason, candidates },
    { status: 404, headers: NO_STORE },
  );
}

function mapSetPropertyError(
  error: unknown,
  candidates: Ga4Candidate[],
): Response {
  if (error instanceof AppError && error.code === "NOT_FOUND") {
    return propertyNotVisible("service_rejected", candidates);
  }
  if (error instanceof AppError && error.code === "FORBIDDEN") {
    return Response.json(
      { error: "property_unverified" },
      { status: 403, headers: NO_STORE },
    );
  }
  return Response.json(
    { error: "attach_failed" },
    { status: 500, headers: NO_STORE },
  );
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

  const project = await findOwnedProject(organizationId, projectId);
  if (!project) {
    return Response.json(
      { error: "project_not_found" },
      { status: 404, headers: NO_STORE },
    );
  }

  const connection = await Ga4Service.getConnection(projectId);
  if (!connection) {
    return Response.json(
      {
        projectId,
        connected: false,
        propertyId: null,
        displayName: null,
        connectedAt: null,
      },
      { headers: NO_STORE },
    );
  }

  return Response.json(
    {
      projectId,
      connected: true,
      propertyId: connection.propertyId,
      displayName: connection.propertyDisplayName,
      connectedAt: connection.createdAt ?? null,
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

  const parsed = postBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  }

  const organizationId = resolveOrganizationId();
  if (organizationId === null) return unsupportedAuthMode();

  const { projectId, propertyId: requestedPropertyId } = parsed.data;
  const project = await findOwnedProject(organizationId, projectId);
  if (!project) {
    return Response.json(
      { error: "project_not_found" },
      { status: 404, headers: NO_STORE },
    );
  }

  const projectDomain = project.domain?.trim() ?? "";
  if (!projectDomain) {
    return Response.json(
      { error: "project_has_no_domain" },
      { status: 400, headers: NO_STORE },
    );
  }

  const existing = await Ga4Service.getConnection(projectId);
  if (existing) {
    if (
      requestedPropertyId == null ||
      requestedPropertyId === existing.propertyId
    ) {
      return Response.json(
        {
          projectId,
          propertyId: existing.propertyId,
          displayName: existing.propertyDisplayName,
          connectedAt: existing.createdAt ?? null,
        },
        { headers: NO_STORE },
      );
    }
    return Response.json(
      {
        error: "already_connected",
        propertyId: existing.propertyId,
        displayName: existing.propertyDisplayName,
      },
      { status: 409, headers: NO_STORE },
    );
  }

  const holders = await resolveGrantHolders(organizationId, "google-analytics");
  if (holders.length === 0) {
    return propertyNotVisible("no_grant", []);
  }

  const domain = normalizeProjectDomain(projectDomain);
  const candidateUnion: Ga4Candidate[] = [];
  let chosen: VisibleProperty | null = null;
  let chosenUserId: string | null = null;
  let chosenCandidates: Ga4Candidate[] = [];

  for (const holder of holders) {
    const listed = await Ga4Service.listPropertiesForUserWithGrantStatus(
      holder.userId,
    );
    const visible = orderVisibleByAccountIds(
      flattenVisibleProperties(listed),
      holder.accountIds,
    );
    const holderCandidates = toCandidates(visible);
    for (const candidate of holderCandidates) {
      if (candidateUnion.length >= 20) break;
      if (candidateUnion.some((row) => row.propertyId === candidate.propertyId)) {
        continue;
      }
      candidateUnion.push(candidate);
    }

    if (requestedPropertyId != null) {
      const match =
        visible.find((property) => property.propertyId === requestedPropertyId) ??
        null;
      if (!match) continue;
      if (!ga4DisplayNameMatches(match.displayName, domain)) {
        return Response.json(
          {
            error: "display_name_mismatch",
            propertyId: match.propertyId,
            displayName: match.displayName,
            domain,
          },
          { status: 409, headers: NO_STORE },
        );
      }
      chosen = match;
      chosenUserId = holder.userId;
      chosenCandidates = holderCandidates;
      break;
    }

    const matches: VisibleProperty[] = [];
    const seenPropertyIds = new Set<string>();
    for (const property of visible) {
      if (!ga4DisplayNameMatches(property.displayName, domain)) continue;
      if (seenPropertyIds.has(property.propertyId)) continue;
      seenPropertyIds.add(property.propertyId);
      matches.push(property);
    }
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      return Response.json(
        {
          error: "ambiguous",
          candidates: matches.map((property) => ({
            propertyId: property.propertyId,
            displayName: property.displayName,
          })),
        },
        { status: 409, headers: NO_STORE },
      );
    }
    const pick = matches[0] ?? null;
    if (!pick) continue;
    chosen = pick;
    chosenUserId = holder.userId;
    chosenCandidates = holderCandidates;
    break;
  }

  if (!chosen || chosenUserId == null) {
    return propertyNotVisible(
      requestedPropertyId != null ? "not_visible" : "no_match",
      candidateUnion,
    );
  }

  try {
    const connection = await Ga4Service.setProperty({
      projectId,
      organizationId,
      propertyId: chosen.propertyId,
      accountId: chosen.accountId,
      userId: chosenUserId,
    });
    return Response.json(
      {
        projectId,
        propertyId: connection.propertyId,
        displayName: connection.propertyDisplayName,
        connectedAt: connection.createdAt ?? null,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return mapSetPropertyError(error, chosenCandidates);
  }
}

export const Route = createFileRoute("/api/internal/ga4")({
  server: {
    handlers: {
      GET: ({ request }) => handleGet(request),
      POST: ({ request }) => handlePost(request),
    },
  },
});
