/**
 * DB-only page SEO fields for HomeGrown OTTO (scan → fixgen).
 * Never calls DataForSEO — reads the latest completed site-audit pages only.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditPages } from "@/db/schema";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import {
  ProjectRepository,
  normalizeProjectDomain,
} from "@/server/features/projects/repositories/ProjectRepository";

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
  pages: AgencyOttoPage[];
};

function normalizeDomain(raw: string): string {
  return normalizeProjectDomain(raw) ?? raw.trim().toLowerCase();
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

// Exact-domain resolution only (never the project name); two projects on the
// same domain throw CONFLICT instead of picking one.
async function findProject(organizationId: string | null, domain: string) {
  return ProjectRepository.resolveProjectByDomain({ domain, organizationId });
}

function pickHomepage(
  pages: AgencyOttoPage[],
  startUrl: string | null,
): AgencyOttoPage | null {
  if (pages.length === 0) return null;
  if (startUrl) {
    const startPath = pathOf(startUrl);
    const match = pages.find((page) => page.path === startPath);
    if (match) return match;
  }
  return (
    pages.find((page) => page.path === "/" || page.path === "") ?? pages[0]
  );
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
  return {
    domain,
    projectId: project.id,
    projectName: project.name,
    auditId: audit.id,
    capturedAt: audit.completedAt ?? audit.startedAt ?? null,
    source: "openseo_audit_pages",
    homepage: pickHomepage(pages, audit.startUrl),
    pages,
  };
}

export async function getAgencyOttoPageInputsGlobal(domain: string) {
  return getAgencyOttoPageInputs({ domain, organizationId: null });
}
