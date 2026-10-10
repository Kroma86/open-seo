import { z } from "zod";

export type AuditReadinessAudit = {
  id: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type AuditReadinessPage = {
  url: string;
  statusCode: number | null;
  fetchClass: string;
  wordCount: number;
};

export type AuditReadinessResult =
  | { ready: true; measuredAt: string; usablePages: number; stale?: { ageDays: number } }
  | { ready: false; reason: string; thinSite?: true };

const MAX_AUDIT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const isoTimestamp = z.iso.datetime({ offset: true });
const sqliteTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function timestampMs(value: string | null): number | null {
  if (!value) return null;
  const normalized = sqliteTimestamp.test(value)
    ? value.replace(" ", "T") + "Z"
    : value;
  if (!isoTimestamp.safeParse(normalized).success) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function ownHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

/** A row that points to a crawl fault, not to a small site: blocked, errored, 5xx, no status, or an empty 200 (client-rendered or challenge page). */
function crawlFailed(page: AuditReadinessPage): boolean {
  return (
    page.fetchClass !== "ok" ||
    page.statusCode === null ||
    page.statusCode >= 500 ||
    (page.statusCode === 200 && !(page.wordCount > 0 && Number.isFinite(page.wordCount)))
  );
}

/** Checks usable crawl evidence for later analysis, not overall site health. */
export function checkAuditReadiness(
  audit: AuditReadinessAudit | null | undefined,
  pages: readonly AuditReadinessPage[],
  domain: string | null,
  now: Date,
  options: { allowStale?: boolean } = {},
): AuditReadinessResult {
  if (!audit) {
    return { ready: false, reason: "No site audit is available." };
  }
  if (audit.status !== "completed") {
    return { ready: false, reason: "The latest site audit has not completed successfully." };
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    return { ready: false, reason: "The current time is invalid." };
  }
  const startedAt = timestampMs(audit.startedAt);
  const completedAt = timestampMs(audit.completedAt);
  if (startedAt === null || completedAt === null) {
    return { ready: false, reason: "The site audit has invalid timestamps." };
  }
  if (startedAt > nowMs || completedAt > nowMs) {
    return { ready: false, reason: "The site audit has timestamps in the future." };
  }
  if (completedAt < startedAt) {
    return { ready: false, reason: "The site audit completed before it started." };
  }
  const stale = nowMs - startedAt > MAX_AUDIT_AGE_MS;
  if (stale && options.allowStale !== true) {
    return { ready: false, reason: "The site audit is older than 7 days." };
  }

  const projectUrl = domain?.trim()
    ? httpUrl(domain.includes("://") ? domain : `https://${domain}`)
    : null;
  if (!projectUrl) {
    return { ready: false, reason: "The project domain is missing or invalid." };
  }
  const expectedHost = ownHost(projectUrl);
  const usableUrls = new Set<string>();
  let ownHostFailures = 0;
  for (const page of pages) {
    const url = httpUrl(page.url);
    // Fail closed: an unparseable URL could be the site's own row.
    if ((!url || ownHost(url) === expectedHost) && crawlFailed(page)) ownHostFailures += 1;
    if (page.statusCode !== 200 || page.fetchClass !== "ok" || !Number.isFinite(page.wordCount) || page.wordCount < 80) continue;
    if (!url || ownHost(url) !== expectedHost) continue;
    // Require distinct paths: scheme, www, query and fragment variants of one
    // page must not make a one-page crawl look like broader site evidence.
    usableUrls.add(url.pathname.replace(/\/+$/, "") || "/");
  }
  if (usableUrls.size < 2) {
    // Exactly one readable own-site page and no sign the crawl failed means
    // the site itself is small. A stale audit never proves that.
    return {
      ready: false,
      reason: "The site audit needs at least 2 usable own-site pages.",
      ...(usableUrls.size === 1 && ownHostFailures === 0 && !stale ? { thinSite: true as const } : {}),
    };
  }
  return {
    ready: true,
    measuredAt: new Date(startedAt).toISOString(),
    usablePages: usableUrls.size,
    ...(stale ? { stale: { ageDays: (nowMs - startedAt) / 86_400_000 } } : {}),
  };
}
