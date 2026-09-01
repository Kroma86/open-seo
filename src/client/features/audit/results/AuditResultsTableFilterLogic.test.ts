import { describe, expect, it } from "vitest";
import {
  EMPTY_PAGES_FILTERS,
  filterPages,
  type PageRow,
  type PagesFilters,
} from "./AuditResultsTableFilterLogic";

function makePage(overrides: Partial<PageRow> = {}): PageRow {
  return {
    id: "page-1",
    auditId: "audit-1",
    url: "https://example.com/page",
    statusCode: 200,
    redirectUrl: null,
    title: "A reasonably sized title tag here",
    metaDescription: "A meta description that sits inside the typical length.",
    canonicalUrl: "https://example.com/page",
    robotsMeta: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1Count: 1,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrderJson: null,
    wordCount: 400,
    imagesTotal: 2,
    imagesMissingAlt: 0,
    imagesJson: null,
    internalLinkCount: 4,
    externalLinkCount: 1,
    hasStructuredData: false,
    hreflangTagsJson: null,
    isIndexable: true,
    xRobotsTag: null,
    headerCanonicalUrl: null,
    crawlDepth: 1,
    inSitemap: true,
    contentHash: "hash-a",
    fetchClass: "ok",
    responseTimeMs: 120,
    ...overrides,
  } as PageRow;
}

function filters(overrides: Partial<PagesFilters> = {}): PagesFilters {
  return { ...EMPTY_PAGES_FILTERS, ...overrides };
}

describe("filterPages existing filters", () => {
  const rows = [
    makePage({
      id: "home",
      url: "https://example.com/",
      title: "Home",
      statusCode: 200,
    }),
    makePage({
      id: "gone",
      url: "https://example.com/gone",
      title: "Missing page",
      statusCode: 404,
    }),
    makePage({
      id: "redir",
      url: "https://example.com/old",
      title: null,
      statusCode: 301,
    }),
  ];

  it("keeps text search across url, title, and meta", () => {
    expect(
      filterPages(rows, filters({ query: "gone" })).map((row) => row.id),
    ).toEqual(["gone"]);
  });

  it("keeps the existing status buckets", () => {
    expect(
      filterPages(rows, filters({ status: "ok" })).map((row) => row.id),
    ).toEqual(["home"]);
    expect(
      filterPages(rows, filters({ status: "redirect" })).map((row) => row.id),
    ).toEqual(["redir"]);
    expect(
      filterPages(rows, filters({ status: "error" })).map((row) => row.id),
    ).toEqual(["gone"]);
  });
});

describe("filterPages new facets", () => {
  it("ANDs status class with other facets", () => {
    const rows = [
      makePage({ id: "ok", statusCode: 200, title: null }),
      makePage({ id: "missing-on-404", statusCode: 404, title: null }),
      makePage({ id: "titled", statusCode: 200, title: "Has a title" }),
    ];

    expect(
      filterPages(
        rows,
        filters({ statusClass: "2xx", missingTitle: true }),
      ).map((row) => row.id),
    ).toEqual(["ok"]);
  });

  it("filters fetch-error independently of HTTP status", () => {
    const rows = [
      makePage({ id: "blocked", statusCode: 200, fetchClass: "blocked" }),
      makePage({ id: "ok", statusCode: 200, fetchClass: "ok" }),
    ];
    expect(
      filterPages(rows, filters({ statusClass: "fetch-error" })).map(
        (row) => row.id,
      ),
    ).toEqual(["blocked"]);
  });

  it("filters 4xx and 5xx separately", () => {
    const rows = [
      makePage({ id: "not-found", statusCode: 404 }),
      makePage({ id: "down", statusCode: 502 }),
    ];
    expect(
      filterPages(rows, filters({ statusClass: "4xx" })).map((row) => row.id),
    ).toEqual(["not-found"]);
    expect(
      filterPages(rows, filters({ statusClass: "5xx" })).map((row) => row.id),
    ).toEqual(["down"]);
  });

  it("filters non-indexable, missing meta, H1, thin content, sitemap", () => {
    const rows = [
      makePage({
        id: "keep",
        robotsMeta: null,
        metaDescription: "present",
        h1Count: 1,
        wordCount: 500,
        inSitemap: true,
      }),
      makePage({
        id: "flagged",
        robotsMeta: "noindex",
        metaDescription: null,
        h1Count: 0,
        wordCount: 20,
        inSitemap: false,
      }),
    ];

    expect(
      filterPages(rows, filters({ nonIndexableOnly: true })).map(
        (row) => row.id,
      ),
    ).toEqual(["flagged"]);
    expect(
      filterPages(rows, filters({ missingMetaDescription: true })).map(
        (row) => row.id,
      ),
    ).toEqual(["flagged"]);
    expect(
      filterPages(rows, filters({ h1NotOne: true })).map((row) => row.id),
    ).toEqual(["flagged"]);
    expect(
      filterPages(rows, filters({ thinContent: true })).map((row) => row.id),
    ).toEqual(["flagged"]);
    expect(
      filterPages(rows, filters({ notInSitemap: true })).map((row) => row.id),
    ).toEqual(["flagged"]);
  });

  it("filters has-issues using pageUrl", () => {
    const rows = [
      makePage({ id: "a", url: "https://example.com/a" }),
      makePage({ id: "b", url: "https://example.com/b" }),
    ];
    expect(
      filterPages(rows, filters({ hasIssues: true }), [
        { pageUrl: "https://example.com/b", severity: "warning" },
      ]).map((row) => row.id),
    ).toEqual(["b"]);
  });

  it("filters duplicates only among 2xx pages sharing a hash", () => {
    const rows = [
      makePage({ id: "a", contentHash: "dup", statusCode: 200 }),
      makePage({
        id: "b",
        url: "https://example.com/b",
        contentHash: "dup",
        statusCode: 200,
      }),
      makePage({
        id: "c",
        url: "https://example.com/c",
        contentHash: "solo",
        statusCode: 200,
      }),
      makePage({
        id: "d",
        url: "https://example.com/d",
        contentHash: "dup",
        statusCode: 404,
      }),
    ];
    // The 404 shares the duplicate hash; grouping ignores it when counting,
    // but the facet still matches any page whose hash is in a 2xx group.
    expect(
      filterPages(rows, filters({ duplicatesOnly: true })).map((row) => row.id),
    ).toEqual(["a", "b", "d"]);
  });
});
