/**
 * Helpers shared by the internal GA4 and GSC attach routes. The `-` prefix
 * keeps the TanStack router generator from treating this file as a route.
 */
import { env } from "cloudflare:workers";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { account, member, user } from "@/db/schema";
import { getAuthMode } from "@/lib/auth-mode";
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

export function assertAgencyToken(request: Request): Response | null {
  // Reusing AGENCY_SCORE_EXPORT_TOKEN is deliberate (one internal-export credential; spec forbade a new token).
  const expected = (
    env as { AGENCY_SCORE_EXPORT_TOKEN?: string }
  ).AGENCY_SCORE_EXPORT_TOKEN?.trim();
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

export const NO_STORE = { "cache-control": "no-store" } as const;

// cloudflare_access folds every legacy delegated-* org into shared-workspace
// (workspace-merge.ts), so that id is the whole tenant there. local_noauth's
// org is delegated-local-admin. hosted uses per-user organizations, where no
// single org is correct for a deployment-wide token — refuse rather than
// read or write someone else's tenant.
export function resolveOrganizationId(): string | null {
  const mode = getAuthMode(env.AUTH_MODE);
  if (mode === "hosted") return null;
  if (mode === "local_noauth") return "delegated-local-admin";
  return "shared-workspace";
}

export function unsupportedAuthMode(): Response {
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

export async function findOwnedProject(
  organizationId: string,
  projectId: string,
) {
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

export async function resolveGrantHolders(
  organizationId: string,
  providerId: string,
) {
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
    const byCreated =
      createdAtMs(left.createdAt) - createdAtMs(right.createdAt);
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
        (left, right) =>
          createdAtMs(left.createdAt) - createdAtMs(right.createdAt),
      );
    if (userGrants.length === 0) continue;
    holders.push({
      userId: candidate.userId,
      accountIds: userGrants.map((grant) => grant.accountId),
    });
  }

  return holders;
}

export function normalizeProjectDomain(raw: string): string {
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
