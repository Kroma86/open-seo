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
  | { ready: true; measuredAt: string; usablePages: number }
  | { ready: false; reason: string };

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

/** Checks usable crawl evidence for later analysis, not overall site health. */
export function checkAuditReadiness(
  audit: AuditReadinessAudit | null | undefined,
  pages: readonly AuditReadinessPage[],
  domain: string | null,
  now: Date,
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
  if (nowMs - startedAt > MAX_AUDIT_AGE_MS) {
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
  for (const page of pages) {
    if (page.statusCode !== 200 || page.fetchClass !== "ok" || !Number.isFinite(page.wordCount) || page.wordCount < 80) continue;
    const url = httpUrl(page.url);
    if (!url || ownHost(url) !== expectedHost) continue;
    // Require distinct paths: scheme, www, query and fragment variants of one
    // page must not make a one-page crawl look like broader site evidence.
    usableUrls.add(url.pathname.replace(/\/+$/, "") || "/");
  }
  if (usableUrls.size < 2) {
    return { ready: false, reason: "The site audit needs at least 2 usable own-site pages." };
  }
  return {
    ready: true,
    measuredAt: new Date(startedAt).toISOString(),
    usablePages: usableUrls.size,
  };
}
