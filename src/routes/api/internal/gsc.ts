import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { account, member, user } from "@/db/schema";
import { getAuthMode } from "@/lib/auth-mode";
import {
  type AgencyScoreInputs,
  loadGscTotals,
} from "@/server/features/agency/AgencyScoreInputsService";
import { GscService } from "@/server/features/gsc/services/GscService";
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
  const rows = await db
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

const SITE_UNVERIFIED_PERMISSION = "siteUnverifiedUser";

const postBodySchema = z.object({
  projectId: z.string().trim().min(1),
  siteUrl: z.string().trim().min(1).max(2048).optional(),
});

type VisibleSite = {
  accountId: string;
  siteUrl: string;
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

function normalizeGscSiteUrlForCompare(siteUrl: string): string {
  const normalized = siteUrl.trim().toLowerCase();
  if (normalized.startsWith("sc-domain:")) {
    return normalized;
  }
  if (
    (normalized.startsWith("http://") || normalized.startsWith("https://")) &&
    normalized.endsWith("/")
  ) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function gscSiteUrlsEqual(left: string, right: string): boolean {
  return normalizeGscSiteUrlForCompare(left) === normalizeGscSiteUrlForCompare(right);
}

function flattenVisibleSites(
  listed: Awaited<ReturnType<typeof GscService.listSitesForUserWithGrantStatus>>,
): VisibleSite[] {
  const visible: VisibleSite[] = [];
  for (const listedAccount of listed.accounts) {
    if (listedAccount.requiresReconnect) continue;
    for (const site of listedAccount.sites) {
      if (site.permissionLevel === SITE_UNVERIFIED_PERMISSION) continue;
      visible.push({
        accountId: listedAccount.accountId,
        siteUrl: site.siteUrl,
      });
    }
  }
  return visible;
}

function parseGscSiteHost(siteUrl: string): string | null {
  const trimmed = siteUrl.trim();
  const scDomainPrefix = "sc-domain:";
  if (trimmed.toLowerCase().startsWith(scDomainPrefix)) {
    const host = trimmed.slice(scDomainPrefix.length).trim().toLowerCase();
    return host || null;
  }
  try {
    const host = new URL(trimmed).hostname.trim().toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

function siteHostMatchesProject(siteUrl: string, domain: string): boolean {
  const host = parseGscSiteHost(siteUrl);
  if (!host) return false;
  return host === domain || host === `www.${domain}`;
}

function orderVisibleByAccountIds(
  visible: VisibleSite[],
  accountIds: string[],
): VisibleSite[] {
  const rank = new Map(accountIds.map((id, index) => [id, index]));
  return visible.toSorted((left, right) => {
    const leftRank = rank.get(left.accountId) ?? Number.POSITIVE_INFINITY;
    const rightRank = rank.get(right.accountId) ?? Number.POSITIVE_INFINITY;
    return leftRank - rightRank;
  });
}

function domainCandidates(visible: VisibleSite[], domain: string): string[] {
  return visible
    .filter((site) => siteHostMatchesProject(site.siteUrl, domain))
    .map((site) => site.siteUrl);
}

function autoPickSite(visible: VisibleSite[], domain: string): VisibleSite | null {
  const candidates = [
    `sc-domain:${domain}`,
    `https://${domain}/`,
    `https://www.${domain}/`,
    `http://${domain}/`,
    `http://www.${domain}/`,
  ];
  for (const siteUrl of candidates) {
    const match = visible.find((site) => gscSiteUrlsEqual(site.siteUrl, siteUrl));
    if (match) return match;
  }
  return null;
}

function propertyNotVisible(
  reason: "no_grant" | "no_match" | "not_visible" | "service_rejected",
  candidates: string[],
): Response {
  return Response.json(
    { error: "property_not_visible", reason, candidates },
    { status: 404, headers: NO_STORE },
  );
}

async function readSnapshot(
  projectId: string,
): Promise<AgencyScoreInputs["gsc"]> {
  try {
    return (await loadGscTotals(projectId, true)) ?? null;
  } catch {
    return null;
  }
}

function mapSetSiteError(error: unknown, candidates: string[]): Response {
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

  const connection = await GscService.getConnection(projectId);
  if (!connection) {
    return Response.json(
      {
        projectId,
        connected: false,
        siteUrl: null,
        connectedAt: null,
        snapshot: null,
      },
      { headers: NO_STORE },
    );
  }

  return Response.json(
    {
      projectId,
      connected: true,
      siteUrl: connection.siteUrl,
      connectedAt: connection.createdAt ?? null,
      snapshot: await readSnapshot(projectId),
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

  const { projectId, siteUrl: requestedSiteUrl } = parsed.data;
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

  const existing = await GscService.getConnection(projectId);
  if (existing) {
    if (requestedSiteUrl == null || requestedSiteUrl === existing.siteUrl) {
      return Response.json(
        {
          projectId,
          siteUrl: existing.siteUrl,
          connectedAt: existing.createdAt ?? null,
          snapshot: await readSnapshot(projectId),
        },
        { headers: NO_STORE },
      );
    }
    return Response.json(
      { error: "already_connected", siteUrl: existing.siteUrl },
      { status: 409, headers: NO_STORE },
    );
  }

  const holders = await resolveGrantHolders(
    organizationId,
    "google-search-console",
  );
  if (holders.length === 0) {
    return propertyNotVisible("no_grant", []);
  }

  const domain = normalizeProjectDomain(projectDomain);
  const candidateUnion: string[] = [];
  let chosen: VisibleSite | null = null;
  let chosenUserId: string | null = null;
  let chosenCandidates: string[] = [];

  for (const holder of holders) {
    const listed = await GscService.listSitesForUserWithGrantStatus(holder.userId);
    const visible = orderVisibleByAccountIds(
      flattenVisibleSites(listed),
      holder.accountIds,
    );
    const holderCandidates = domainCandidates(visible, domain);
    for (const candidate of holderCandidates) {
      if (candidateUnion.length >= 20) break;
      if (candidateUnion.includes(candidate)) continue;
      candidateUnion.push(candidate);
    }

    if (requestedSiteUrl != null) {
      const match =
        visible.find((site) => gscSiteUrlsEqual(site.siteUrl, requestedSiteUrl)) ??
        null;
      if (!match) continue;
      if (!siteHostMatchesProject(match.siteUrl, domain)) {
        return Response.json(
          { error: "site_url_mismatch", siteUrl: match.siteUrl, domain },
          { status: 409, headers: NO_STORE },
        );
      }
      chosen = match;
      chosenUserId = holder.userId;
      chosenCandidates = holderCandidates;
      break;
    }

    const pick = autoPickSite(visible, domain);
    if (!pick) continue;
    chosen = pick;
    chosenUserId = holder.userId;
    chosenCandidates = holderCandidates;
    break;
  }

  if (!chosen || chosenUserId == null) {
    return propertyNotVisible(
      requestedSiteUrl != null ? "not_visible" : "no_match",
      candidateUnion,
    );
  }

  try {
    const connection = await GscService.setSite({
      projectId,
      organizationId,
      siteUrl: chosen.siteUrl,
      accountId: chosen.accountId,
      userId: chosenUserId,
    });
    return Response.json(
      {
        projectId,
        siteUrl: connection.siteUrl,
        connectedAt: connection.createdAt ?? null,
        snapshot: await readSnapshot(projectId),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return mapSetSiteError(error, chosenCandidates);
  }
}

export const Route = createFileRoute("/api/internal/gsc")({
  server: {
    handlers: {
      GET: ({ request }) => handleGet(request),
      POST: ({ request }) => handlePost(request),
    },
  },
});
