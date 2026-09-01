import { describe, expect, it } from "vitest";
import {
  charLengthTone,
  classifyCanonical,
  duplicateGroupsByContentHash,
  indexableDisplay,
  isDuplicatePage,
  isH1NotOne,
  isMissingMetaDescription,
  isMissingTitle,
  isNonIndexable,
  isNotInSitemap,
  isThinContent,
  issueCountsByPageUrl,
  matchesStatusClass,
  META_DESCRIPTION_LENGTH_RANGE,
  normalizeTrailingSlash,
  pageHasIssues,
  THIN_CONTENT_WORD_THRESHOLD,
  TITLE_LENGTH_RANGE,
} from "./PageExplorerLogic";

describe("issueCountsByPageUrl", () => {
  it("returns an empty map for empty input", () => {
    expect(issueCountsByPageUrl([])).toEqual(new Map());
  });

  it("counts issues per page URL", () => {
    const counts = issueCountsByPageUrl([
      { pageUrl: "https://example.com/a", severity: "info" },
      { pageUrl: "https://example.com/a", severity: "warning" },
      { pageUrl: "https://example.com/b", severity: "critical" },
    ]);

    expect(counts.get("https://example.com/a")).toEqual({
      count: 2,
      worstSeverity: "warning",
    });
    expect(counts.get("https://example.com/b")).toEqual({
      count: 1,
      worstSeverity: "critical",
    });
  });

  it("orders severity critical > warning > info", () => {
    const counts = issueCountsByPageUrl([
      { pageUrl: "https://example.com/a", severity: "info" },
      { pageUrl: "https://example.com/a", severity: "critical" },
      { pageUrl: "https://example.com/a", severity: "warning" },
    ]);

    expect(counts.get("https://example.com/a")?.worstSeverity).toBe("critical");
  });

  it("treats unknown severity values as info", () => {
    const counts = issueCountsByPageUrl([
      { pageUrl: "https://example.com/a", severity: "notice" },
    ]);

    expect(counts.get("https://example.com/a")).toEqual({
      count: 1,
      worstSeverity: "info",
    });
  });
});

describe("duplicateGroupsByContentHash", () => {
  it("returns an empty map for empty input", () => {
    expect(duplicateGroupsByContentHash([])).toEqual(new Map());
  });

  it("ignores null and empty hashes", () => {
    expect(
      duplicateGroupsByContentHash([
        { contentHash: null, statusCode: 200 },
        { contentHash: "", statusCode: 200 },
        { contentHash: "   ", statusCode: 200 },
        { contentHash: null, statusCode: 200 },
      ]),
    ).toEqual(new Map());
  });

  it("ignores pages whose status is outside 200-299", () => {
    expect(
      duplicateGroupsByContentHash([
        { contentHash: "abc", statusCode: 200 },
        { contentHash: "abc", statusCode: 404 },
        { contentHash: "abc", statusCode: 301 },
        { contentHash: "abc", statusCode: null },
        { contentHash: "abc", statusCode: 500 },
      ]),
    ).toEqual(new Map());
  });

  it("keeps only hashes that appear more than once on 2xx pages", () => {
    const groups = duplicateGroupsByContentHash([
      { contentHash: "dup", statusCode: 200 },
      { contentHash: "dup", statusCode: 299 },
      { contentHash: "solo", statusCode: 200 },
      { contentHash: "redir", statusCode: 301 },
      { contentHash: "redir", statusCode: 302 },
    ]);

    expect(Object.fromEntries(groups)).toEqual({ dup: 2 });
  });
});

describe("canonical trailing-slash normalization", () => {
  it("strips trailing slashes", () => {
    expect(normalizeTrailingSlash("https://example.com/page/")).toBe(
      "https://example.com/page",
    );
    expect(normalizeTrailingSlash("https://example.com/")).toBe(
      "https://example.com",
    );
  });

  it("classifies self, other, and missing", () => {
    expect(
      classifyCanonical(
        "https://example.com/page/",
        "https://example.com/page",
      ),
    ).toBe("self");
    expect(
      classifyCanonical(
        "https://example.com/page",
        "https://example.com/other/",
      ),
    ).toBe("other");
    expect(classifyCanonical("https://example.com/page", null)).toBe("missing");
    expect(classifyCanonical("https://example.com/page", "  ")).toBe("missing");
  });
});

describe("indexableDisplay", () => {
  it("uses the first matching reason: robotsMeta, then xRobotsTag, then flag", () => {
    expect(
      indexableDisplay({
        robotsMeta: "noindex, follow",
        xRobotsTag: "noindex",
        isIndexable: false,
      }),
    ).toEqual({ indexable: false, reason: "robotsMeta noindex" });
    expect(
      indexableDisplay({
        robotsMeta: "index, follow",
        xRobotsTag: "NOINDEX",
        isIndexable: false,
      }),
    ).toEqual({ indexable: false, reason: "xRobotsTag noindex" });
    expect(
      indexableDisplay({
        robotsMeta: null,
        xRobotsTag: null,
        isIndexable: false,
      }),
    ).toEqual({ indexable: false, reason: "flag" });
    expect(
      indexableDisplay({
        robotsMeta: null,
        xRobotsTag: null,
        isIndexable: true,
      }),
    ).toEqual({ indexable: true, reason: null });
  });
});

describe("charLengthTone", () => {
  it("is red when missing, green inside the range, amber otherwise", () => {
    expect(
      charLengthTone(null, TITLE_LENGTH_RANGE.min, TITLE_LENGTH_RANGE.max),
    ).toBe("red");
    expect(charLengthTone("   ", 30, 60)).toBe("red");
    expect(charLengthTone("a".repeat(45), 30, 60)).toBe("green");
    expect(charLengthTone("short", 30, 60)).toBe("amber");
    expect(
      charLengthTone(
        "a".repeat(80),
        META_DESCRIPTION_LENGTH_RANGE.min,
        META_DESCRIPTION_LENGTH_RANGE.max,
      ),
    ).toBe("green");
  });
});

describe("filter predicates", () => {
  it("matchesStatusClass covers 2xx/3xx/4xx/5xx and fetch-error", () => {
    expect(
      matchesStatusClass({ statusCode: 200, fetchClass: "ok" }, "all"),
    ).toBe(true);
    expect(
      matchesStatusClass({ statusCode: 204, fetchClass: "ok" }, "2xx"),
    ).toBe(true);
    expect(
      matchesStatusClass({ statusCode: 301, fetchClass: "ok" }, "3xx"),
    ).toBe(true);
    expect(
      matchesStatusClass({ statusCode: 404, fetchClass: "ok" }, "4xx"),
    ).toBe(true);
    expect(
      matchesStatusClass({ statusCode: 503, fetchClass: "ok" }, "5xx"),
    ).toBe(true);
    expect(
      matchesStatusClass(
        { statusCode: 200, fetchClass: "blocked" },
        "fetch-error",
      ),
    ).toBe(true);
    expect(
      matchesStatusClass({ statusCode: 200, fetchClass: "ok" }, "fetch-error"),
    ).toBe(false);
    expect(
      matchesStatusClass({ statusCode: null, fetchClass: "ok" }, "2xx"),
    ).toBe(false);
    expect(
      matchesStatusClass({ statusCode: 404, fetchClass: "ok" }, "2xx"),
    ).toBe(false);
  });

  it("isNonIndexable when any noindex signal is present", () => {
    expect(
      isNonIndexable({
        robotsMeta: "noindex",
        xRobotsTag: null,
        isIndexable: true,
      }),
    ).toBe(true);
    expect(
      isNonIndexable({
        robotsMeta: null,
        xRobotsTag: null,
        isIndexable: true,
      }),
    ).toBe(false);
  });

  it("isMissingTitle treats null and blank as missing", () => {
    expect(isMissingTitle({ title: null })).toBe(true);
    expect(isMissingTitle({ title: "  " })).toBe(true);
    expect(isMissingTitle({ title: "Home" })).toBe(false);
  });

  it("isMissingMetaDescription treats null and blank as missing", () => {
    expect(isMissingMetaDescription({ metaDescription: null })).toBe(true);
    expect(isMissingMetaDescription({ metaDescription: "" })).toBe(true);
    expect(isMissingMetaDescription({ metaDescription: "A description" })).toBe(
      false,
    );
  });

  it("isH1NotOne is true unless there is exactly one H1", () => {
    expect(isH1NotOne({ h1Count: 0 })).toBe(true);
    expect(isH1NotOne({ h1Count: 2 })).toBe(true);
    expect(isH1NotOne({ h1Count: 1 })).toBe(false);
  });

  it("isThinContent uses a 300-word threshold", () => {
    expect(isThinContent({ wordCount: 0 })).toBe(true);
    expect(isThinContent({ wordCount: 299 })).toBe(true);
    expect(isThinContent({ wordCount: THIN_CONTENT_WORD_THRESHOLD })).toBe(
      false,
    );
  });

  it("pageHasIssues is false for empty counts and URLs with zero issues", () => {
    const counts = issueCountsByPageUrl([
      { pageUrl: "https://example.com/a", severity: "warning" },
    ]);
    expect(pageHasIssues("https://example.com/a", counts)).toBe(true);
    expect(pageHasIssues("https://example.com/b", counts)).toBe(false);
    expect(pageHasIssues("https://example.com/a", new Map())).toBe(false);
  });

  it("isDuplicatePage is true only for hashes in groups with count > 1", () => {
    const groups = duplicateGroupsByContentHash([
      { contentHash: "dup", statusCode: 200 },
      { contentHash: "dup", statusCode: 200 },
      { contentHash: "solo", statusCode: 200 },
    ]);
    expect(isDuplicatePage({ contentHash: "dup" }, groups)).toBe(true);
    expect(isDuplicatePage({ contentHash: "solo" }, groups)).toBe(false);
    expect(isDuplicatePage({ contentHash: null }, groups)).toBe(false);
  });

  it("isNotInSitemap is the inverse of inSitemap", () => {
    expect(isNotInSitemap({ inSitemap: false })).toBe(true);
    expect(isNotInSitemap({ inSitemap: true })).toBe(false);
  });
});
