import { and, count, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { AppError } from "@/server/lib/errors";

async function listProjects(organizationId: string) {
  return db.query.projects.findMany({
    where: and(
      eq(projects.organizationId, organizationId),
      isNull(projects.archivedAt),
    ),
    orderBy: [desc(projects.createdAt), desc(projects.id)],
  });
}

async function countProjects(organizationId: string) {
  const [row] = await db
    .select({ value: count() })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    );
  return row?.value ?? 0;
}

async function getProjectForOrganization(
  projectId: string,
  organizationId: string,
) {
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return project ?? null;
}

// Look up a project by id alone (no org scoping). Only for trusted server
// contexts that have already authorized access another way — e.g. the
// onboarding chat Durable Object, whose connections are authorized in the
// Worker before they reach the DO, and which derives its org from the project.
async function getProjectById(projectId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.archivedAt)))
    .limit(1);
  return project ?? null;
}

export function normalizeProjectDomain(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  let host = raw.trim().toLowerCase();
  for (const prefix of ["https://", "http://"]) {
    if (host.startsWith(prefix)) host = host.slice(prefix.length);
  }
  if (host.startsWith("www.")) host = host.slice(4);
  host = host.split("/")[0] ?? host;
  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  return host || null;
}

function domainMatchSql(needle: string) {
  return or(
    sql`lower(${projects.domain}) = ${needle}`,
    sql`lower(${projects.domain}) = ${`www.${needle}`}`,
    sql`lower(${projects.domain}) = ${`https://${needle}/`}`,
    sql`lower(${projects.domain}) = ${`https://www.${needle}/`}`,
    sql`lower(${projects.domain}) = ${`http://${needle}/`}`,
    sql`lower(${projects.domain}) = ${`http://www.${needle}/`}`,
  );
}

// Unscoped domain match for trusted server paths (Hermes soak trigger).
// Every unarchived row whose lower(domain) equals the normalised host,
// www.<host>, or those hosts stored with an http(s) scheme and trailing
// slash. Input is normalised in JS; stored values are compared in SQL.
async function getProjectsByDomain(domain: string) {
  const needle = normalizeProjectDomain(domain);
  if (!needle) return [];
  return db
    .select()
    .from(projects)
    .where(and(isNull(projects.archivedAt), domainMatchSql(needle)));
}

async function getProjectByDomain(domain: string) {
  const [row] = await getProjectsByDomain(domain);
  return row ?? null;
}

// Same exact-domain match, limited to one organization.
async function getProjectsByDomainForOrganization(
  organizationId: string,
  domain: string,
) {
  const needle = normalizeProjectDomain(domain);
  if (!needle) return [];
  return db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
        domainMatchSql(needle),
      ),
    );
}

// Resolve a hostname to exactly one project. Exact domain only — never the
// project name (a name equal to someone else's domain must not resolve).
// Zero rows → null. More than one row → CONFLICT: two projects claim the same
// domain and no caller may pick one silently. `organizationId: null` is the
// unscoped form for trusted bearer paths (Hermes).
async function resolveProjectByDomain(input: {
  domain: string;
  organizationId: string | null;
}) {
  const rows = input.organizationId
    ? await getProjectsByDomainForOrganization(
        input.organizationId,
        input.domain,
      )
    : await getProjectsByDomain(input.domain);
  if (rows.length > 1) {
    throw new AppError(
      "CONFLICT",
      `ambiguous_project_domain: ${rows.length} projects share ${normalizeProjectDomain(input.domain) ?? input.domain}`,
    );
  }
  return rows[0] ?? null;
}

async function createProject(
  organizationId: string,
  name: string,
  domain?: string,
  // Omitted keeps the column defaults.
  market?: { locationCode: number; languageCode: string },
) {
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(projects)
    .values({ id, organizationId, name, domain, ...market })
    .returning();
  return row;
}

async function updateProject(
  projectId: string,
  organizationId: string,
  input: {
    name: string;
    domain?: string;
    // Omitted leaves the market columns untouched.
    market?: { locationCode: number; languageCode: string };
  },
) {
  const [row] = await db
    .update(projects)
    .set({ name: input.name, domain: input.domain ?? null, ...input.market })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .returning();

  if (!row) {
    throw new AppError("NOT_FOUND");
  }

  return row;
}

// Writes only the domain column, for the dashboard's inline domain input.
async function updateProjectDomain(
  projectId: string,
  organizationId: string,
  domain: string,
) {
  const [row] = await db
    .update(projects)
    .set({ domain })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .returning();

  if (!row) {
    throw new AppError("NOT_FOUND");
  }

  return row;
}

// Writes only the market columns. Onboarding sets the project's market before
// the user has named the project or picked a domain, so it must not go through
// updateProject, whose `domain: input.domain ?? null` would clear the domain.
async function updateProjectMarket(
  projectId: string,
  organizationId: string,
  market: { locationCode: number; languageCode: string },
) {
  const [row] = await db
    .update(projects)
    .set(market)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .returning();

  if (!row) {
    throw new AppError("NOT_FOUND");
  }

  return row;
}

async function tryCreateDefaultProject(organizationId: string) {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(projects)
    .values({
      id,
      organizationId,
      name: "Default",
      domain: null,
    })
    .onConflictDoNothing()
    .returning({ id: projects.id });
  return inserted.length > 0 ? id : null;
}

async function listArchivedProjects(organizationId: string) {
  return db.query.projects.findMany({
    where: and(
      eq(projects.organizationId, organizationId),
      isNotNull(projects.archivedAt),
    ),
    orderBy: [desc(projects.archivedAt), desc(projects.id)],
  });
}

async function restoreProject(projectId: string, organizationId: string) {
  const [row] = await db
    .update(projects)
    .set({ archivedAt: null })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNotNull(projects.archivedAt),
      ),
    )
    .returning({ id: projects.id });

  if (!row) {
    throw new AppError("NOT_FOUND");
  }
}

async function setLoopsEnabled(
  projectId: string,
  organizationId: string,
  enabled: boolean,
) {
  const [row] = await db
    .update(projects)
    .set({ loopsEnabled: enabled })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .returning();
  return row ?? null;
}

async function archiveProject(projectId: string, organizationId: string) {
  const [row] = await db
    .update(projects)
    .set({ archivedAt: sql`(current_timestamp)`, loopsEnabled: false })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .returning({ id: projects.id });

  if (!row) {
    throw new AppError("NOT_FOUND");
  }
}

export const ProjectRepository = {
  listProjects,
  listArchivedProjects,
  countProjects,
  getProjectForOrganization,
  getProjectById,
  getProjectByDomain,
  getProjectsByDomain,
  getProjectsByDomainForOrganization,
  resolveProjectByDomain,
  createProject,
  updateProject,
  updateProjectDomain,
  updateProjectMarket,
  tryCreateDefaultProject,
  setLoopsEnabled,
  archiveProject,
  restoreProject,
} as const;
