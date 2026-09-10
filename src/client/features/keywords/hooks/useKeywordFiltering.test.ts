import { describe, expect, it } from "vitest";
import type { KeywordIntent, KeywordResearchRow } from "@/types/keywords";
import {
  EMPTY_FILTERS,
  parseIntentFilter,
  toggleIntentFilter,
  type KeywordFilterValues,
} from "@/client/features/keywords/keywordResearchTypes";
import { applyKeywordFiltersAndSort } from "./useKeywordFiltering";

function makeRow(
  keyword: string,
  intent: KeywordIntent,
  overrides: Partial<KeywordResearchRow> = {},
): KeywordResearchRow {
  return {
    keyword,
    searchVolume: 100,
    trend: [],
    keywordDifficulty: 10,
    cpc: 1,
    competition: 0.5,
    intent,
    ...overrides,
  };
}

function filter(
  rows: KeywordResearchRow[],
  overrides: Partial<KeywordFilterValues>,
): KeywordResearchRow[] {
  return applyKeywordFiltersAndSort({
    rows,
    filters: { ...EMPTY_FILTERS, ...overrides },
    sortField: "keyword",
    sortDir: "asc",
  });
}

const rows: KeywordResearchRow[] = [
  makeRow("buy running shoes", "transactional"),
  makeRow("best running shoes", "commercial"),
  makeRow("how to run", "informational"),
  makeRow("nike store", "navigational"),
  makeRow("mystery term", "unknown"),
];

const FILTERABLE_METRICS = [
  { metric: "searchVolume", minKey: "minVol", maxKey: "maxVol" },
  { metric: "cpc", minKey: "minCpc", maxKey: "maxCpc" },
  { metric: "keywordDifficulty", minKey: "minKd", maxKey: "maxKd" },
] as const;

const NUMERIC_SORT_FIELDS = [
  "searchVolume",
  "cpc",
  "competition",
  "keywordDifficulty",
] as const;

function metricRows(
  metric: (typeof FILTERABLE_METRICS)[number]["metric"],
): KeywordResearchRow[] {
  return [
    makeRow("a-null", "informational", { [metric]: null }),
    makeRow("b-undef", "informational", { [metric]: undefined }),
    makeRow("c-zero", "informational", { [metric]: 0 }),
    makeRow("d-ten", "informational", { [metric]: 10 }),
    makeRow("e-fifty", "informational", { [metric]: 50 }),
  ];
}

const ALL_METRIC_KEYWORDS = ["a-null", "b-undef", "c-zero", "d-ten", "e-fifty"];

describe("parseIntentFilter", () => {
  it("returns an empty list for an empty string", () => {
    expect(parseIntentFilter("")).toEqual([]);
  });

  it("parses a comma-separated string in canonical order", () => {
    expect(parseIntentFilter("transactional,informational")).toEqual([
      "informational",
      "transactional",
    ]);
  });

  it("drops unknown tokens and de-duplicates", () => {
    expect(parseIntentFilter("commercial,bogus,commercial")).toEqual([
      "commercial",
    ]);
  });
});

describe("toggleIntentFilter", () => {
  it("adds an intent when absent and keeps canonical order", () => {
    expect(toggleIntentFilter("transactional", "informational")).toBe(
      "informational,transactional",
    );
  });

  it("removes an intent when already present", () => {
    expect(
      toggleIntentFilter("informational,transactional", "informational"),
    ).toBe("transactional");
  });
});

describe("applyKeywordFiltersAndSort — intent filtering", () => {
  it("returns every row when no intent is selected", () => {
    expect(filter(rows, { intents: "" })).toHaveLength(rows.length);
  });

  it("keeps only rows matching a single selected intent", () => {
    const result = filter(rows, { intents: "transactional" });
    expect(result.map((r) => r.keyword)).toEqual(["buy running shoes"]);
  });

  it("keeps rows matching any of multiple selected intents", () => {
    const result = filter(rows, { intents: "transactional,commercial" });
    expect(result.map((r) => r.keyword).toSorted()).toEqual([
      "best running shoes",
      "buy running shoes",
    ]);
  });

  it("combines the intent filter with other filters (AND)", () => {
    // "running" narrows to the two shoe rows; intent narrows to the commercial one.
    const result = filter(rows, {
      include: "running",
      intents: "commercial",
    });
    expect(result.map((r) => r.keyword)).toEqual(["best running shoes"]);
  });

  it("ignores invalid intent tokens (treated as no intent match constraint)", () => {
    const result = filter(rows, { intents: "bogus" });
    expect(result).toHaveLength(rows.length);
  });
});

describe("applyKeywordFiltersAndSort — numeric range filters", () => {
  it.each(
    FILTERABLE_METRICS.flatMap((metric) =>
      [
        {
          name: "min-only",
          min: "10",
          max: "",
          kept: ["d-ten", "e-fifty"],
        },
        {
          name: "max-only",
          min: "",
          max: "10",
          kept: ["c-zero", "d-ten"],
        },
        {
          name: "min+max",
          min: "10",
          max: "50",
          kept: ["d-ten", "e-fifty"],
        },
        {
          name: "min 0",
          min: "0",
          max: "",
          kept: ["c-zero", "d-ten", "e-fifty"],
        },
        {
          name: "max 0",
          min: "",
          max: "0",
          kept: ["c-zero"],
        },
        {
          name: "min 0 + max 0",
          min: "0",
          max: "0",
          kept: ["c-zero"],
        },
        {
          name: "no bounds",
          min: "",
          max: "",
          kept: ALL_METRIC_KEYWORDS,
        },
        {
          name: "invalid min",
          min: "abc",
          max: "",
          kept: ALL_METRIC_KEYWORDS,
        },
        {
          name: "invalid max",
          min: "",
          max: "NaN",
          kept: ALL_METRIC_KEYWORDS,
        },
        {
          name: "invalid min+max",
          min: "foo",
          max: "bar",
          kept: ALL_METRIC_KEYWORDS,
        },
        {
          name: "valid min + invalid max",
          min: "10",
          max: "nope",
          kept: ["d-ten", "e-fifty"],
        },
        {
          name: "whitespace numeric min",
          min: " 10 ",
          max: "",
          kept: ["d-ten", "e-fifty"],
        },
        {
          name: "whitespace-only min as 0",
          min: " ",
          max: "",
          kept: ["c-zero", "d-ten", "e-fifty"],
        },
        {
          name: "min Infinity",
          min: "Infinity",
          max: "",
          kept: [] as string[],
        },
        {
          name: "max Infinity",
          min: "",
          max: "Infinity",
          kept: ["c-zero", "d-ten", "e-fifty"],
        },
      ].map((boundCase) => ({ ...metric, ...boundCase })),
    ),
  )(
    "$metric $name keeps $kept",
    ({ metric, minKey, maxKey, min, max, kept }) => {
      const result = filter(metricRows(metric), {
        [minKey]: min,
        [maxKey]: max,
      });
      expect(result.map((r) => r.keyword)).toEqual(kept);
    },
  );

  it("does not exclude a row for missing metrics that have no active bound", () => {
    const source = [
      makeRow("keep-missing-others", "informational", {
        searchVolume: 80,
        cpc: null,
        keywordDifficulty: undefined,
        competition: null,
      }),
    ];
    expect(filter(source, { minVol: "10" }).map((r) => r.keyword)).toEqual([
      "keep-missing-others",
    ]);
  });
});

describe("applyKeywordFiltersAndSort — numeric sorting", () => {
  it.each(
    NUMERIC_SORT_FIELDS.flatMap((field) =>
      (
        [
          [
            "asc",
            ["c-zero", "d-ten", "d-ten-tie", "e-fifty", "a-null", "b-undef"],
          ],
          [
            "desc",
            ["e-fifty", "d-ten", "d-ten-tie", "c-zero", "a-null", "b-undef"],
          ],
        ] as const
      ).map(([dir, expected]) => ({ field, dir, expected })),
    ),
  )(
    "sorts $field $dir with missing last, measured 0 in order, and stable ties",
    ({ field, dir, expected }) => {
      const source = [
        makeRow("a-null", "informational", { [field]: null }),
        makeRow("d-ten", "informational", { [field]: 10 }),
        makeRow("c-zero", "informational", { [field]: 0 }),
        makeRow("b-undef", "informational", { [field]: undefined }),
        makeRow("e-fifty", "informational", { [field]: 50 }),
        makeRow("d-ten-tie", "informational", { [field]: 10 }),
      ];
      const result = applyKeywordFiltersAndSort({
        rows: source,
        filters: EMPTY_FILTERS,
        sortField: field,
        sortDir: dir,
      });
      expect(result.map((r) => r.keyword)).toEqual(expected);
    },
  );
});

describe("applyKeywordFiltersAndSort — inputs and combined constraints", () => {
  it("does not mutate the input rows array or row objects", () => {
    const source = [
      makeRow("alpha", "informational", { searchVolume: 3 }),
      makeRow("beta", "informational", { searchVolume: null }),
      makeRow("gamma", "informational", { searchVolume: 1 }),
    ];
    const rowRefs = [...source];
    const snapshot = source.map((row) => ({ ...row }));

    const result = applyKeywordFiltersAndSort({
      rows: source,
      filters: { ...EMPTY_FILTERS, minVol: "2" },
      sortField: "searchVolume",
      sortDir: "desc",
    });

    expect(source).toEqual(snapshot);
    expect(source[0]).toBe(rowRefs[0]);
    expect(source[1]).toBe(rowRefs[1]);
    expect(source[2]).toBe(rowRefs[2]);
    expect(result).not.toBe(source);
    expect(result.map((r) => r.keyword)).toEqual(["alpha"]);
  });

  it("applies numeric bounds together with include, exclude, and intent", () => {
    const source = [
      makeRow("buy running shoes", "transactional"),
      makeRow("best running shoes", "commercial", { searchVolume: null }),
      makeRow("how to run", "informational"),
      makeRow("running socks", "transactional"),
    ];
    const result = filter(source, {
      include: "running",
      exclude: "socks",
      intents: "transactional,commercial",
      minVol: "1",
    });
    expect(result.map((r) => r.keyword)).toEqual(["buy running shoes"]);
  });
});
