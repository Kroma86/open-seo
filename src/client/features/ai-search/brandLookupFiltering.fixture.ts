// Shared rows and filter builders for brandLookupFiltering tests.
import type { BrandLookupResult } from "@/types/schemas/ai-search";
import {
  EMPTY_QUERIES_FILTERS,
  EMPTY_TOP_PAGES_FILTERS,
  type QueriesFilterValues,
  type TopPagesFilterValues,
} from "./brandLookupFilterTypes";

type TopPage = BrandLookupResult["topPages"][number];
type TopQuery = BrandLookupResult["topQueries"][number];

export function makePage(overrides: Partial<TopPage> = {}): TopPage {
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

export function makeQuery(overrides: Partial<TopQuery> = {}): TopQuery {
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

export function pagesFilters(
  overrides: Partial<TopPagesFilterValues> = {},
): TopPagesFilterValues {
  return { ...EMPTY_TOP_PAGES_FILTERS, ...overrides };
}

export function queriesFilters(
  overrides: Partial<QueriesFilterValues> = {},
): QueriesFilterValues {
  return { ...EMPTY_QUERIES_FILTERS, ...overrides };
}

export const PAGE = {
  missingNull: "https://acme.test/null",
  missingUndefined: "https://acme.test/undefined",
  zero: "https://acme.test/zero",
  five: "https://acme.test/five",
  ten: "https://acme.test/ten",
  twenty: "https://acme.test/twenty",
} as const;

export const QUERY = {
  missingNull: "null volume query",
  missingUndefined: "undefined volume query",
  zero: "zero volume query",
  five: "five volume query",
  ten: "ten volume query",
  twenty: "twenty volume query",
} as const;

export function numericPages(): TopPage[] {
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

export function numericQueries(): TopQuery[] {
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

export function pageUrls(rows: TopPage[]): string[] {
  return rows.map((row) => row.url);
}

export function queryQuestions(rows: TopQuery[]): string[] {
  return rows.map((row) => row.question);
}
