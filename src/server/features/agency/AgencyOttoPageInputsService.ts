/**
 * DB-only page SEO fields for HomeGrown OTTO (scan → fixgen).
 * Never calls DataForSEO — reads the latest completed site-audit pages only.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { auditPages, projects } from "@/db/schema";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";

export type AgencyOttoPage = {
  url: string;
  path: string;
  httpStatus: number | null;
  title: string | null;
  titleLength: number | null;
  description: string | null;
  descriptionLength: number | null;
  canonical: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  h1Count: number;
  wordCount: number;
  imagesMissingAlt: number;
  checksFlagged: string[];
};

export type AgencyOttoPageInputs = {
  domain: string;
  projectId: string | null;
  projectName: string | null;
  auditId: string | null;
  capturedAt: string | null;
  source: "openseo_audit_pages";
  homepage: AgencyOttoPage | null;
  /**
   * Why `homepage` is null, so a missing homepage reads as a finding rather
   * than a blank cell. "ok" whenever homepage is non-null.
   */
  homepageReason: HomepageReason;
  pages: AgencyOttoPage[];
};

export type HomepageReason =
  | "ok"
  | "no_pages_crawled"
  | "no_pages_on_project_domain"
  | "root_not_in_audit";

function normalizeDomain(raw: string): string {
  let host = raw.trim().toLowerCase();
  for (const prefix of ["https://", "http://"]) {
    if (host.startsWith(prefix)) host = host.slice(prefix.length);
  }
  if (host.startsWith("www.")) host = host.slice(4);
  return host.split("/")[0] ?? host;
}

function domainsMatch(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  return normalizeDomain(a) === normalizeDomain(b);
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname || "/";
  } catch {
    return "/";
  }
}

function flagChecks(page: {
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  h1Count: number;
  wordCount: number;
  imagesMissingAlt: number;
}): string[] {
  const flags: string[] = [];
  const title = page.title?.trim() ?? "";
  const description = page.metaDescription?.trim() ?? "";
  if (!title) flags.push("title_missing");
  else if (title.length > 60) flags.push("title_too_long");
  else if (title.length < 30) flags.push("title_too_short");
  if (!description) flags.push("description_missing");
  else if (description.length > 160) flags.push("description_too_long");
  else if (description.length < 70) flags.push("description_too_short");
  if (!page.canonicalUrl) flags.push("canonical_missing");
  if (page.h1Count === 0) flags.push("h1_missing");
  else if (page.h1Count > 1) flags.push("h1_multiple");
  if (page.wordCount > 0 && page.wordCount < 300) flags.push("thin_content");
  if (page.imagesMissingAlt > 0) flags.push("images_missing_alt");
  return flags;
}

function toOttoPage(row: {
  url: string;
  statusCode: number | null;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  h1Count: number;
  wordCount: number;
  imagesMissingAlt: number;
}): AgencyOttoPage {
  const title = row.title;
  const description = row.metaDescription;
  return {
    url: row.url,
    path: pathOf(row.url),
    httpStatus: row.statusCode,
    title,
    titleLength: title?.length ?? null,
    description,
    descriptionLength: description?.length ?? null,
    canonical: row.canonicalUrl,
    ogTitle: row.ogTitle,
    ogDescription: row.ogDescription,
    h1Count: row.h1Count,
    wordCount: row.wordCount,
    imagesMissingAlt: row.imagesMissingAlt,
    checksFlagged: flagChecks(row),
  };
}

async function findProject(
  organizationId: string | null,
  domain: string,
): Promise<typeof projects.$inferSelect | null> {
  const needle = normalizeDomain(domain);
  const rows = organizationId
    ? await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.organizationId, organizationId),
            isNull(projects.archivedAt),
          ),
        )
    : await db.select().from(projects).where(isNull(projects.archivedAt));

  const exact = rows.find((project) => domainsMatch(project.domain, needle));
  if (exact) return exact;
  return rows.find((project) => domainsMatch(project.name, needle)) ?? null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isRootPath(path: string): boolean {
  return path === "/" || path === "";
}

/**
 * The homepage is the crawled root page of the project's OWN domain.
 *
 * This used to fall back to `pages[0]` when no root page was found. Pages are
 * ordered by crawl depth then URL ascending, so that fallback silently returned
 * the alphabetically-first page and labelled it the homepage — "/about",
 * "/blog", "/_serverless/...". Every downstream title, description and H1 check
 * then scored the wrong page, and nothing in the output said so. It also never
 * checked the host, so an audit that had crawled a different domain entirely
 * was accepted without complaint.
 *
 * Both failures are now explicit: a homepage is returned only when it is the
 * root of the project's own domain, and otherwise the caller gets null plus a
 * reason. A missing homepage is a finding, not something to paper over.
 */
function pickHomepage(
  pages: AgencyOttoPage[],
  startUrl: string | null,
  domain: string,
): { homepage: AgencyOttoPage | null; reason: HomepageReason } {
  if (pages.length === 0) {
    return { homepage: null, reason: "no_pages_crawled" };
  }

  const onDomain = pages.filter((page) =>
    domainsMatch(hostOf(page.url), domain),
  );
  if (onDomain.length === 0) {
    return { homepage: null, reason: "no_pages_on_project_domain" };
  }

  // Honour an explicit audit start URL, but only on the project's own domain.
  if (startUrl && domainsMatch(hostOf(startUrl), domain)) {
    const startPath = pathOf(startUrl);
    const match = onDomain.find((page) => page.path === startPath);
    if (match) return { homepage: match, reason: "ok" };
  }

  const root = onDomain.find((page) => isRootPath(page.path));
  return root
    ? { homepage: root, reason: "ok" }
    : { homepage: null, reason: "root_not_in_audit" };
}

export async function getAgencyOttoPageInputs(input: {
  domain: string;
  organizationId?: string | null;
  limit?: number;
}): Promise<AgencyOttoPageInputs> {
  const domain = normalizeDomain(input.domain);
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const empty: AgencyOttoPageInputs = {
    domain,
    projectId: null,
    projectName: null,
    auditId: null,
    capturedAt: null,
    source: "openseo_audit_pages",
    homepage: null,
    homepageReason: "no_pages_crawled",
    pages: [],
  };

  const project = await findProject(input.organizationId ?? null, domain);
  if (!project) return empty;

  const audit = await AuditRepository.getLatestAuditForProject(project.id);
  if (!audit) {
    return {
      ...empty,
      projectId: project.id,
      projectName: project.name,
    };
  }

  const rows = await db
    .select({
      url: auditPages.url,
      statusCode: auditPages.statusCode,
      title: auditPages.title,
      metaDescription: auditPages.metaDescription,
      canonicalUrl: auditPages.canonicalUrl,
      ogTitle: auditPages.ogTitle,
      ogDescription: auditPages.ogDescription,
      h1Count: auditPages.h1Count,
      wordCount: auditPages.wordCount,
      imagesMissingAlt: auditPages.imagesMissingAlt,
      crawlDepth: auditPages.crawlDepth,
    })
    .from(auditPages)
    .where(
      and(eq(auditPages.auditId, audit.id), eq(auditPages.fetchClass, "ok")),
    )
    .orderBy(asc(auditPages.crawlDepth), asc(auditPages.url))
    .limit(limit);

  const pages = rows.map(toOttoPage);
  const picked = pickHomepage(pages, audit.startUrl, domain);
  return {
    domain,
    projectId: project.id,
    projectName: project.name,
    auditId: audit.id,
    capturedAt: audit.completedAt ?? audit.startedAt ?? null,
    source: "openseo_audit_pages",
    homepage: picked.homepage,
    homepageReason: picked.reason,
    pages,
  };
}

export async function getAgencyOttoPageInputsGlobal(domain: string) {
  return getAgencyOttoPageInputs({ domain, organizationId: null });
}
