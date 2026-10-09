import { account, user } from "@/db/schema";
import type { ProjectService } from "@/server/features/projects/services/ProjectService";

// Shared fixtures for the internal agency-token routes that resolve an
// unattended actor (audits, ga4, gsc). Each test file keeps its own vi.mock
// calls; this module only holds data and builders.

export const TOKEN = "test-export-token";
export const ORG_ID = "shared-workspace";
export const PROJECT_ID = "project_1";
export const auth = { authorization: `Bearer ${TOKEN}` };

export type MockEnv = {
  AGENCY_SCORE_EXPORT_TOKEN?: string;
  AUTH_MODE?: string;
};

export const PROJECT: Awaited<
  ReturnType<(typeof ProjectService)["getProjectForOrganization"]>
> = {
  id: PROJECT_ID,
  name: "Acme",
  domain: "example.com",
  locationCode: 2840,
  languageCode: "en",
  createdAt: "2026-01-01 00:00:00",
};

export type ActorRow = {
  userId: string;
  userEmail: string | null;
  createdAt: Date;
};

export type GrantRow = { userId: string; accountId: string; createdAt: Date };

export const EARLY_MEMBER: ActorRow = {
  userId: "user_early",
  userEmail: "early@example.com",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

export const LATE_MEMBER: ActorRow = {
  userId: "user_late",
  userEmail: "late@example.com",
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
};

export function requestBuilders(base: string) {
  return {
    get: (path = "", headers?: HeadersInit): Request =>
      new Request(`${base}${path}`, { headers }),
    post: (body?: unknown, headers?: HeadersInit, rawBody?: string): Request =>
      new Request(base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...Object.fromEntries(new Headers(headers)),
        },
        body:
          rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
      }),
  };
}

type ActorSources = {
  listMembers: () => Promise<ActorRow[]>;
  listUsers: () => Promise<ActorRow[]>;
  listGrants?: () => Promise<GrantRow[]>;
};

// Stands in for the drizzle builder used by the routes' actor lookups. Every
// such query ends in orderBy(), so that call resolves the rows: users for
// `from(user)`, grants for `from(account)`, members otherwise (the member
// query joins user).
export function createActorDb(sources: ActorSources) {
  let kind: "members" | "users" | "grants" = "members";
  const chain = {
    from(table: unknown) {
      kind =
        table === user ? "users" : table === account ? "grants" : "members";
      return chain;
    },
    innerJoin: () => chain,
    where: () => chain,
    orderBy(): Promise<unknown[]> {
      if (kind === "users") return sources.listUsers();
      if (kind === "grants") {
        return sources.listGrants?.() ?? Promise.resolve([]);
      }
      return sources.listMembers();
    },
  };
  return { select: () => chain };
}
