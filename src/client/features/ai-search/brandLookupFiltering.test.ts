import { describe, expect, it } from "vitest";
import type { BrandLookupResult } from "@/types/schemas/ai-search";
import {
  EMPTY_QUERIES_FILTERS,
  EMPTY_TOP_PAGES_FILTERS,
  type QueriesFilterValues,
  type TopPagesFilterValues,
} from "./brandLookupFilterTypes";
import { filterQueries, filterTopPages } from "./brandLookupFiltering";

type TopPage = BrandLookupResult["topPages"][number];
type TopQuery = BrandLookupResult["topQueries"][number];

function makePage(overrides: Partial<TopPage> = {}): TopPage {
  const row: TopPage = {
    url: "https://acme.test/guide",
    domain: "acme.test",
    platform: "chat_gpt",
    mentions: 10,
    capturedVolume: 100,
    keywords: [{ question: "what is acme", aiSearchVolume: 40 }],
  };
  return Object.assign(row, overrides);
}

function makeQuery(overrides: Partial<TopQuery> = {}): TopQuery {
  const row: TopQuery = {
    question: "what is acme",
    platform: "chat_gpt",
    aiSearchVolume: 10,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-02-01T00:00:00.000Z",
    citedSources: [
      {
        url: "https://acme.test/guide",
        domain: "acme.test",
        title: "Acme guide",
      },
    ],
    brandsMentioned: ["acme"],
  };
  return Object.assign(row, overrides);
}

function pagesFilters(
  overrides: Partial<TopPagesFilterValues> = {},
): TopPagesFilterValues {
  return { ...EMPTY_TOP_PAGES_FILTERS, ...overrides };
}

function queriesFilters(
  overrides: Partial<QueriesFilterValues> = {},
): QueriesFilterValues {
  return { ...EMPTY_QUERIES_FILTERS, ...overrides };
}

const PAGE = {
  missingNull: "https://acme.test/null",
  missingUndefined: "https://acme.test/undefined",
  zero: "https://acme.test/zero",
  five: "https://acme.test/five",
  ten: "https://acme.test/ten",
  twenty: "https://acme.test/twenty",
} as const;

const QUERY = {
  missingNull: "null volume query",
  missingUndefined: "undefined volume query",
  zero: "zero volume query",
  five: "five volume query",
  ten: "ten volume query",
  twenty: "twenty volume query",
} as const;

function numericPages(): TopPage[] {
  const undefinedMentions = makePage({
    url: PAGE.missingUndefined,
    mentions: 10,
  });
  Object.assign(undefinedMentions, { mentions: undefined });
  return [
    makePage({ url: PAGE.missingNull, mentions: null }),
    undefinedMentions,
    makePage({ url: PAGE.zero, mentions: 0 }),
    makePage({ url: PAGE.five, mentions: 5 }),
    makePage({ url: PAGE.ten, mentions: 10 }),
    makePage({ url: PAGE.twenty, mentions: 20 }),
  ];
}

function numericQueries(): TopQuery[] {
  const undefinedVolume = makeQuery({
    question: QUERY.missingUndefined,
    aiSearchVolume: 10,
  });
  Object.assign(undefinedVolume, { aiSearchVolume: undefined });
  return [
    makeQuery({ question: QUERY.missingNull, aiSearchVolume: null }),
    undefinedVolume,
    makeQuery({ question: QUERY.zero, aiSearchVolume: 0 }),
    makeQuery({ question: QUERY.five, aiSearchVolume: 5 }),
    makeQuery({ question: QUERY.ten, aiSearchVolume: 10 }),
    makeQuery({ question: QUERY.twenty, aiSearchVolume: 20 }),
  ];
}

function pageUrls(rows: TopPage[]): string[] {
  return rows.map((row) => row.url);
}

function queryQuestions(rows: TopQuery[]): string[] {
  return rows.map((row) => row.question);
}

describe("filterTopPages", () => {
  it("keeps null, undefined, zero, and positive mentions when no bounds are set", () => {
    const rows = numericPages();
    expect(pageUrls(filterTopPages(rows, pagesFilters()))).toEqual(
      pageUrls(rows),
    );
  });

  it("excludes missing mentions for min-only and includes the exact min", () => {
    const rows = numericPages();
    expect(
      pageUrls(filterTopPages(rows, pagesFilters({ minMentions: "5" }))),
    ).toEqual([PAGE.five, PAGE.ten, PAGE.twenty]);
  });

  it("excludes missing mentions for max-only and includes the exact max", () => {
    const rows = numericPages();
    expect(
      pageUrls(filterTopPages(rows, pagesFilters({ maxMentions: "10" }))),
    ).toEqual([PAGE.zero, PAGE.five, PAGE.ten]);
  });

  it("applies combined inclusive bounds and excludes missing mentions", () => {
    const rows = numericPages();
    expect(
      pageUrls(
        filterTopPages(
          rows,
          pagesFilters({ minMentions: "5", maxMentions: "10" }),
        ),
      ),
    ).toEqual([PAGE.five, PAGE.ten]);
  });

  it("treats both invalid numeric strings as inactive bounds", () => {
    const rows = numericPages();
    expect(
      pageUrls(
        filterTopPages(
          rows,
          pagesFilters({ minMentions: "abc", maxMentions: "NaN" }),
        ),
      ),
    ).toEqual(pageUrls(rows));
  });

  it("applies only the valid bound when the other string is invalid", () => {
    const rows = numericPages();
    expect(
      pageUrls(
        filterTopPages(
          rows,
          pagesFilters({ minMentions: "abc", maxMentions: "10" }),
        ),
      ),
    ).toEqual([PAGE.zero, PAGE.five, PAGE.ten]);
    expect(
      pageUrls(
        filterTopPages(
          rows,
          pagesFilters({ minMentions: "5", maxMentions: "NaN" }),
        ),
      ),
    ).toEqual([PAGE.five, PAGE.ten, PAGE.twenty]);
  });

  it("includes measured zero at zero bounds and excludes missing mentions", () => {
    const rows = numericPages();
    expect(
      pageUrls(
        filterTopPages(
          rows,
          pagesFilters({ minMentions: "0", maxMentions: "0" }),
        ),
      ),
    ).toEqual([PAGE.zero]);
  });

  it("activates bounds with original string-truthy Number parsing", () => {
    const rows = numericPages();
    expect(
      pageUrls(filterTopPages(rows, pagesFilters({ minMentions: " " }))),
    ).toEqual([PAGE.zero, PAGE.five, PAGE.ten, PAGE.twenty]);
    expect(
      pageUrls(filterTopPages(rows, pagesFilters({ maxMentions: "Infinity" }))),
    ).toEqual([PAGE.zero, PAGE.five, PAGE.ten, PAGE.twenty]);
  });

  it("ANDs text and platform filters with numeric bounds", () => {
    const rows = [
      makePage({
        url: "https://acme.test/guide",
        domain: "acme.test",
        platform: "chat_gpt",
        mentions: 10,
        keywords: [{ question: "what is acme", aiSearchVolume: 40 }],
      }),
      makePage({
        url: "https://acme.test/guide-google",
        domain: "acme.test",
        platform: "google",
        mentions: 10,
        keywords: [{ question: "what is acme", aiSearchVolume: 40 }],
      }),
      makePage({
        url: "https://acme.test/pricing",
        domain: null,
        platform: "chat_gpt",
        mentions: 10,
        keywords: [{ question: "acme pricing", aiSearchVolume: 20 }],
      }),
      makePage({
        url: "https://other.test/guide",
        domain: "other.test",
        platform: "chat_gpt",
        mentions: 1,
        keywords: [{ question: "unrelated", aiSearchVolume: 1 }],
      }),
    ];

    expect(
      pageUrls(
        filterTopPages(
          rows,
          pagesFilters({
            include: "guide",
            platform: "chat_gpt",
            minMentions: "5",
          }),
        ),
      ),
    ).toEqual(["https://acme.test/guide"]);

    expect(
      pageUrls(
        filterTopPages(
          rows,
          pagesFilters({
            exclude: "pricing",
            minMentions: "5",
          }),
        ),
      ),
    ).toEqual(["https://acme.test/guide", "https://acme.test/guide-google"]);

    expect(
      pageUrls(
        filterTopPages(
          rows,
          pagesFilters({
            include: "what is acme",
            maxMentions: "10",
          }),
        ),
      ),
    ).toEqual(["https://acme.test/guide", "https://acme.test/guide-google"]);
  });

  it("does not mutate the input array or rows", () => {
    const rows = numericPages();
    const snapshot = rows.map((row) => ({
      ...row,
      keywords: row.keywords.map((keyword) => ({ ...keyword })),
    }));
    Object.freeze(rows);
    for (const row of rows) Object.freeze(row);

    const result = filterTopPages(
      rows,
      pagesFilters({ minMentions: "5", maxMentions: "10" }),
    );

    expect(rows).toEqual(snapshot);
    expect(result).not.toBe(rows);
    expect(result[0]).toBe(rows[3]);
    expect(pageUrls(result)).toEqual([PAGE.five, PAGE.ten]);
  });
});

describe("filterQueries", () => {
  it("keeps null, undefined, zero, and positive volume when no bounds are set", () => {
    const rows = numericQueries();
    expect(queryQuestions(filterQueries(rows, queriesFilters()))).toEqual(
      queryQuestions(rows),
    );
  });

  it("excludes missing volume for min-only and includes the exact min", () => {
    const rows = numericQueries();
    expect(
      queryQuestions(filterQueries(rows, queriesFilters({ minVolume: "5" }))),
    ).toEqual([QUERY.five, QUERY.ten, QUERY.twenty]);
  });

  it("excludes missing volume for max-only and includes the exact max", () => {
    const rows = numericQueries();
    expect(
      queryQuestions(filterQueries(rows, queriesFilters({ maxVolume: "10" }))),
    ).toEqual([QUERY.zero, QUERY.five, QUERY.ten]);
  });

  it("applies combined inclusive bounds and excludes missing volume", () => {
    const rows = numericQueries();
    expect(
      queryQuestions(
        filterQueries(
          rows,
          queriesFilters({ minVolume: "5", maxVolume: "10" }),
        ),
      ),
    ).toEqual([QUERY.five, QUERY.ten]);
  });

  it("treats both invalid numeric strings as inactive bounds", () => {
    const rows = numericQueries();
    expect(
      queryQuestions(
        filterQueries(
          rows,
          queriesFilters({ minVolume: "abc", maxVolume: "NaN" }),
        ),
      ),
    ).toEqual(queryQuestions(rows));
  });

  it("applies only the valid bound when the other string is invalid", () => {
    const rows = numericQueries();
    expect(
      queryQuestions(
        filterQueries(
          rows,
          queriesFilters({ minVolume: "abc", maxVolume: "10" }),
        ),
      ),
    ).toEqual([QUERY.zero, QUERY.five, QUERY.ten]);
    expect(
      queryQuestions(
        filterQueries(
          rows,
          queriesFilters({ minVolume: "5", maxVolume: "NaN" }),
        ),
      ),
    ).toEqual([QUERY.five, QUERY.ten, QUERY.twenty]);
  });

  it("includes measured zero at zero bounds and excludes missing volume", () => {
    const rows = numericQueries();
    expect(
      queryQuestions(
        filterQueries(rows, queriesFilters({ minVolume: "0", maxVolume: "0" })),
      ),
    ).toEqual([QUERY.zero]);
  });

  it("activates bounds with original string-truthy Number parsing", () => {
    const rows = numericQueries();
    expect(
      queryQuestions(filterQueries(rows, queriesFilters({ minVolume: " " }))),
    ).toEqual([QUERY.zero, QUERY.five, QUERY.ten, QUERY.twenty]);
    expect(
      queryQuestions(
        filterQueries(rows, queriesFilters({ maxVolume: "Infinity" })),
      ),
    ).toEqual([QUERY.zero, QUERY.five, QUERY.ten, QUERY.twenty]);
  });

  it("ANDs text and platform filters with numeric bounds", () => {
    const rows = [
      makeQuery({
        question: "best acme tools",
        platform: "chat_gpt",
        aiSearchVolume: 10,
        brandsMentioned: ["acme"],
      }),
      makeQuery({
        question: "best acme tools google",
        platform: "google",
        aiSearchVolume: 10,
        brandsMentioned: ["acme"],
      }),
      makeQuery({
        question: "rival comparison",
        platform: "chat_gpt",
        aiSearchVolume: 10,
        brandsMentioned: ["rival"],
      }),
      makeQuery({
        question: "best acme tools low",
        platform: "chat_gpt",
        aiSearchVolume: 1,
        brandsMentioned: ["acme"],
      }),
    ];

    expect(
      queryQuestions(
        filterQueries(
          rows,
          queriesFilters({
            include: "acme",
            platform: "chat_gpt",
            minVolume: "5",
          }),
        ),
      ),
    ).toEqual(["best acme tools"]);

    expect(
      queryQuestions(
        filterQueries(
          rows,
          queriesFilters({
            exclude: "rival",
            minVolume: "5",
          }),
        ),
      ),
    ).toEqual(["best acme tools", "best acme tools google"]);

    expect(
      queryQuestions(
        filterQueries(
          rows,
          queriesFilters({
            include: "rival",
            maxVolume: "10",
          }),
        ),
      ),
    ).toEqual(["rival comparison"]);
  });

  it("does not mutate the input array or rows", () => {
    const rows = numericQueries();
    const snapshot = rows.map((row) => ({
      ...row,
      citedSources: row.citedSources.map((source) => ({ ...source })),
      brandsMentioned: [...row.brandsMentioned],
    }));
    Object.freeze(rows);
    for (const row of rows) Object.freeze(row);

    const result = filterQueries(
      rows,
      queriesFilters({ minVolume: "5", maxVolume: "10" }),
    );

    expect(rows).toEqual(snapshot);
    expect(result).not.toBe(rows);
    expect(result[0]).toBe(rows[3]);
    expect(queryQuestions(result)).toEqual([QUERY.five, QUERY.ten]);
  });
});
