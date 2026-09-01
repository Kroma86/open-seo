import type { IssueSeverity } from "@/shared/audit-issues";
import { ISSUE_SEVERITY_ORDER } from "@/shared/audit-issues";

export const THIN_CONTENT_WORD_THRESHOLD = 300;
export const TITLE_LENGTH_RANGE = { min: 30, max: 60 } as const;
export const META_DESCRIPTION_LENGTH_RANGE = { min: 50, max: 160 } as const;

export type CharLengthTone = "green" | "amber" | "red";
export type CanonicalKind = "self" | "other" | "missing";
export type StatusClass = "all" | "2xx" | "3xx" | "4xx" | "5xx" | "fetch-error";

export type PageIssueCounts = {
  count: number;
  worstSeverity: IssueSeverity;
};

export type IndexableDisplay =
  | { indexable: true; reason: null }
  | {
      indexable: false;
      reason: "robotsMeta noindex" | "xRobotsTag noindex" | "flag";
    };

type IssueCountInput = {
  pageUrl: string;
  severity: string;
};

type DuplicatePageInput = {
  contentHash: string | null;
  statusCode: number | null;
};

export type PageExplorerRow = {
  url: string;
  statusCode: number | null;
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  isIndexable: boolean;
  h1Count: number;
  wordCount: number;
  contentHash: string | null;
  inSitemap: boolean;
  fetchClass: string;
};

export function asIssueSeverity(value: string): IssueSeverity {
  if (value === "critical" || value === "warning" || value === "info") {
    return value;
  }
  return "info";
}

export function worseSeverity(
  left: IssueSeverity,
  right: IssueSeverity,
): IssueSeverity {
  return ISSUE_SEVERITY_ORDER[left] <= ISSUE_SEVERITY_ORDER[right]
    ? left
    : right;
}

export function issueCountsByPageUrl(
  issues: ReadonlyArray<IssueCountInput>,
): Map<string, PageIssueCounts> {
  const counts = new Map<string, PageIssueCounts>();
  for (const issue of issues) {
    const severity = asIssueSeverity(issue.severity);
    const existing = counts.get(issue.pageUrl);
    if (!existing) {
      counts.set(issue.pageUrl, { count: 1, worstSeverity: severity });
      continue;
    }
    existing.count += 1;
    existing.worstSeverity = worseSeverity(existing.worstSeverity, severity);
  }
  return counts;
}

function isSuccessStatus(statusCode: number | null): boolean {
  return statusCode != null && statusCode >= 200 && statusCode < 300;
}

export function duplicateGroupsByContentHash(
  pages: ReadonlyArray<DuplicatePageInput>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const hash = page.contentHash?.trim() ?? "";
    if (!hash) continue;
    if (!isSuccessStatus(page.statusCode)) continue;
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  for (const [hash, count] of counts) {
    if (count <= 1) counts.delete(hash);
  }
  return counts;
}

/** Strip trailing slashes so `/page` and `/page/` compare as the same URL. */
export function normalizeTrailingSlash(url: string): string {
  if (!url) return url;
  return url.replace(/\/+$/, "") || url;
}

export function classifyCanonical(
  pageUrl: string,
  canonicalUrl: string | null,
): CanonicalKind {
  const canonical = canonicalUrl?.trim() ?? "";
  if (!canonical) return "missing";
  return normalizeTrailingSlash(canonical) === normalizeTrailingSlash(pageUrl)
    ? "self"
    : "other";
}

function containsNoindex(value: string | null): boolean {
  return (value ?? "").toLowerCase().includes("noindex");
}

export function indexableDisplay(page: {
  robotsMeta: string | null;
  xRobotsTag: string | null;
  isIndexable: boolean;
}): IndexableDisplay {
  if (containsNoindex(page.robotsMeta)) {
    return { indexable: false, reason: "robotsMeta noindex" };
  }
  if (containsNoindex(page.xRobotsTag)) {
    return { indexable: false, reason: "xRobotsTag noindex" };
  }
  if (!page.isIndexable) {
    return { indexable: false, reason: "flag" };
  }
  return { indexable: true, reason: null };
}

export function charLengthTone(
  value: string | null,
  min: number,
  max: number,
): CharLengthTone {
  const length = value?.trim().length ?? 0;
  if (length === 0) return "red";
  if (length >= min && length <= max) return "green";
  return "amber";
}

export function matchesStatusClass(
  page: Pick<PageExplorerRow, "statusCode" | "fetchClass">,
  statusClass: StatusClass,
): boolean {
  if (statusClass === "all") return true;
  if (statusClass === "fetch-error") return page.fetchClass !== "ok";
  const code = page.statusCode;
  if (code == null) return false;
  if (statusClass === "2xx") return code >= 200 && code < 300;
  if (statusClass === "3xx") return code >= 300 && code < 400;
  if (statusClass === "4xx") return code >= 400 && code < 500;
  return code >= 500 && code < 600;
}

export function isNonIndexable(
  page: Pick<PageExplorerRow, "robotsMeta" | "xRobotsTag" | "isIndexable">,
): boolean {
  return !indexableDisplay(page).indexable;
}

export function isMissingTitle(page: Pick<PageExplorerRow, "title">): boolean {
  return !page.title?.trim();
}

export function isMissingMetaDescription(
  page: Pick<PageExplorerRow, "metaDescription">,
): boolean {
  return !page.metaDescription?.trim();
}

export function isH1NotOne(page: Pick<PageExplorerRow, "h1Count">): boolean {
  return page.h1Count !== 1;
}

export function isThinContent(
  page: Pick<PageExplorerRow, "wordCount">,
): boolean {
  return page.wordCount < THIN_CONTENT_WORD_THRESHOLD;
}

export function pageHasIssues(
  pageUrl: string,
  counts: Map<string, PageIssueCounts>,
): boolean {
  return (counts.get(pageUrl)?.count ?? 0) > 0;
}

export function isDuplicatePage(
  page: Pick<PageExplorerRow, "contentHash">,
  groups: Map<string, number>,
): boolean {
  const hash = page.contentHash?.trim() ?? "";
  return Boolean(hash) && (groups.get(hash) ?? 0) > 1;
}

export function isNotInSitemap(
  page: Pick<PageExplorerRow, "inSitemap">,
): boolean {
  return !page.inSitemap;
}
