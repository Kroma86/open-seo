import { describe, expect, it } from "vitest";
import { checkAuditReadiness } from "./loopFreshness";

const now = new Date("2026-09-12T12:00:00.000Z");
const audit = {
  id: "synthetic-audit",
  status: "completed",
  startedAt: "2026-09-10T10:00:00.000Z",
  completedAt: "2026-09-10T11:00:00.000Z",
};
const page = {
  url: "https://example.com/",
  statusCode: 200,
  fetchClass: "ok",
  wordCount: 80,
};
const pages = [page, { ...page, url: "https://example.com/services" }];
const unavailable = { ready: false, reason: "No site audit is available." };
const invalidTimestamps = { ready: false, reason: "The site audit has invalid timestamps." };
const insufficientPages = { ready: false, reason: "The site audit needs at least 2 usable own-site pages." };

describe("checkAuditReadiness", () => {
  it("accepts a recent completed audit with two usable own-site URLs", () => {
    expect(checkAuditReadiness(audit, pages, "example.com", now)).toEqual({
      ready: true,
      measuredAt: audit.startedAt,
      usablePages: 2,
    });
  });

  it.each([null, undefined])("rejects a missing audit", (missing) => {
    expect(checkAuditReadiness(missing, pages, "example.com", now)).toEqual(unavailable);
  });

  it.each(["running", "failed", "pending"])("rejects audit status %s", (status) => {
    expect(checkAuditReadiness({ ...audit, status }, pages, "example.com", now)).toEqual({ready:false,reason:"The latest site audit has not completed successfully."});
  });

  it("rejects an invalid current time", () => {
    expect(checkAuditReadiness(audit, pages, "example.com", new Date(NaN))).toEqual({
      ready: false,
      reason: "The current time is invalid.",
    });
  });

  it.each([
    null,
    "",
    "not-a-date",
    "2026-09-10",
    "2026-09-10T10:00:00",
    "09/10/2026 10:00:00",
    "2026-02-30T10:00:00Z",
    "2026-02-30 10:00:00",
    "2026-09-10T24:00:00Z",
    "2026-09-10T10:60:00Z",
    "2026-09-10T10:00:00+25:00",
  ])("rejects invalid start or completion timestamp %s", (timestamp) => {
    expect(checkAuditReadiness({ ...audit, startedAt: timestamp }, pages, "example.com", now)).toEqual(invalidTimestamps);
    expect(checkAuditReadiness({ ...audit, completedAt: timestamp }, pages, "example.com", now)).toEqual(invalidTimestamps);
  });

  it("reads SQLite timestamps as UTC and accepts exactly seven days", () => {
    expect(checkAuditReadiness({ ...audit, startedAt: "2026-09-05 12:00:00", completedAt: "2026-09-05 13:00:00" }, pages, "example.com", now)).toEqual({
      ready: true,
      measuredAt: "2026-09-05T12:00:00.000Z",
      usablePages: 2,
    });
  });

  it("accepts ISO offsets at the seven-day boundary", () => {
    expect(checkAuditReadiness({ ...audit, startedAt: "2026-09-05T17:30:00+05:30", completedAt: "2026-09-05T08:00:00-05:00" }, pages, "example.com", now)).toEqual({
      ready: true,
      measuredAt: "2026-09-05T12:00:00.000Z",
      usablePages: 2,
    });
  });

  it("rejects an audit started one millisecond beyond seven days even if it just completed", () => {
    expect(checkAuditReadiness({ ...audit, startedAt: "2026-09-05T11:59:59.999Z", completedAt: now.toISOString() }, pages, "example.com", now)).toEqual({
      ready: false,
      reason: "The site audit is older than 7 days.",
    });
  });

  it.each([
    { ...audit, startedAt: "2026-09-12T12:00:00.001Z", completedAt: "2026-09-12T12:00:00.002Z" },
    { ...audit, completedAt: "2026-09-12T12:00:00.001Z" },
  ])("rejects future audit timestamps", (futureAudit) => {
    expect(checkAuditReadiness(futureAudit, pages, "example.com", now)).toEqual({
      ready: false,
      reason: "The site audit has timestamps in the future.",
    });
  });

  it("rejects completion before start", () => {
    expect(checkAuditReadiness({ ...audit, completedAt: "2026-09-10T09:59:59.999Z" }, pages, "example.com", now)).toEqual({
      ready: false,
      reason: "The site audit completed before it started.",
    });
  });

  it("accepts equal timestamps at the current time", () => {
    expect(checkAuditReadiness({ ...audit, startedAt: now.toISOString(), completedAt: now.toISOString() }, pages, "example.com", now)).toEqual({
      ready: true,
      measuredAt: now.toISOString(),
      usablePages: 2,
    });
  });

  it.each([null, "", "not a domain", "https://user:password@example.com", "ftp://example.com"])("rejects invalid project domain %s", (domain) => {
    expect(checkAuditReadiness(audit, pages, domain, now)).toEqual({
      ready: false,
      reason: "The project domain is missing or invalid.",
    });
  });

  it.each([{ pages: [] }, { pages: [page] }, { pages: [{ ...page, wordCount: 0 }] }])("rejects empty, single-page or blank completed audits", (candidate) => {
    expect(checkAuditReadiness(audit, candidate.pages, "example.com", now)).toEqual(insufficientPages);
  });

  it.each([
    { ...pages[1]!, url: "https://elsewhere.example/services" },
    { ...pages[1]!, url: "https://example.com.evil.example/services" },
    { ...pages[1]!, url: "https://sub.example.com/services" },
    { ...pages[1]!, url: "/services" },
    { ...pages[1]!, url: "not-a-url" },
    { ...pages[1]!, url: "ftp://example.com/services" },
    { ...pages[1]!, url: "https://user@example.com/services" },
    { ...pages[1]!, url: "https://user:password@example.com/services" },
    { ...pages[1]!, statusCode: null },
    { ...pages[1]!, statusCode: 201 },
    { ...pages[1]!, statusCode: 301 },
    { ...pages[1]!, statusCode: 404 },
    { ...pages[1]!, statusCode: 500 },
    { ...pages[1]!, fetchClass: "blocked" },
    { ...pages[1]!, fetchClass: "error" },
    { ...pages[1]!, wordCount: 0 },
    { ...pages[1]!, wordCount: 79 },
    { ...pages[1]!, wordCount: NaN },
    { ...pages[1]!, wordCount: Infinity },
  ])("does not count an unusable second page", (unusable) => {
    expect(checkAuditReadiness(audit, [page, unusable], "example.com", now)).toEqual(insufficientPages);
  });

  it("deduplicates repeated URL rows and fragment variants", () => {
    const duplicates = [page, { ...page }, { ...page, url: "https://example.com/#contact" }];
    expect(checkAuditReadiness(audit, duplicates, "example.com", now)).toEqual(insufficientPages);
  });

  it("counts only the unique usable own-site URLs", () => {
    expect(checkAuditReadiness(audit, [...pages, page, { ...page, url: "https://elsewhere.example/" }, { ...page, url: "https://example.com/blank", wordCount: 0 }], "example.com", now)).toEqual({
      ready: true,
      measuredAt: audit.startedAt,
      usablePages: 2,
    });
  });

  it("does not count homepage scheme, www or tracking variants as separate pages", () => {
    const ownPages = ["http://example.com/", "https://www.example.com/", "https://example.com/?utm_source=example"].map(url => ({ ...page, url }));
    expect(checkAuditReadiness(audit, ownPages, "WWW.EXAMPLE.COM", now)).toEqual(insufficientPages);
  });

  it("does not expose the audit ID or invalid page URL in rejection reasons", () => {
    const candidate = { ...audit, id: "private-audit-marker" };
    const result = checkAuditReadiness(candidate, [{ ...page, url: "https://secret-user:secret-password@example.com/private-path" }], "example.com", now);
    expect(result).toEqual(insufficientPages);
    expect(JSON.stringify(result)).not.toMatch(/private|secret|example\.com/);
  });

  it("does not mutate the supplied audit, pages or clock", () => {
    const frozenAudit = Object.freeze({ ...audit });
    const frozenPages = Object.freeze(pages.map((row) => Object.freeze({ ...row })));
    const before = now.getTime();
    expect(checkAuditReadiness(frozenAudit, frozenPages, "example.com", now).ready).toBe(true);
    expect(now.getTime()).toBe(before);
  });
});
