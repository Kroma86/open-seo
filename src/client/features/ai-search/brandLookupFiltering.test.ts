import { describe, expect, it } from "vitest";
import { filterQueries, filterTopPages } from "./brandLookupFiltering";
import {
  makePage,
  makeQuery,
  numericPages,
  numericQueries,
  PAGE,
  pageUrls,
  pagesFilters,
  QUERY,
  queriesFilters,
  queryQuestions,
} from "./brandLookupFiltering.fixture";

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
