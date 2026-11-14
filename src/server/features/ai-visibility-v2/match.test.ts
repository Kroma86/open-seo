import { describe, expect, it } from "vitest";
import {
  parseMeasurement,
  summarizeMeasurements,
  wilson95,
  type MeasurementRow,
} from "./match";

const parse = (raw: unknown) =>
  parseMeasurement("chatgpt", raw, "Example Studio", "example.test");
const row = (overrides: Partial<MeasurementRow> = {}): MeasurementRow => ({
  promptId: "q1",
  engine: "chatgpt",
  status: "completed",
  named: false,
  cited: false,
  citedDomains: [],
  ...overrides,
});

describe("queued scraper matching", () => {
  it("keeps an uncited answer mention separate from cited-source matching", () => {
    expect(
      parse({
        markdown: "Try Example Studio.",
        search_results: [{ url: "https://example.test/" }],
      }),
    ).toEqual({
      named: true,
      cited: false,
      channels: ["answer_text"],
      citedDomains: [],
    });
  });
  it("matches entity URLs and nested local businesses without inventing citations", () => {
    expect(
      parse({
        brand_entities: [
          { title: "Other label", urls: [{ domain: "www.example.test" }] },
        ],
        items: [
          {
            type: "chat_gpt_local_businesses",
            items: [
              {
                type: "chat_gpt_local_businesses_element",
                title: "Example Studio",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      named: true,
      cited: false,
      channels: ["entity", "local_business"],
      citedDomains: [],
    });
  });
  it("records cited hosts and matches only exact hosts or subdomains, never source titles", () => {
    expect(
      parse({
        markdown: "A valid answer",
        sources: [
          {
            title: "Example Studio",
            url: "https://example.test.attacker.test/",
          },
          { domain: "journal.example.test" },
          { url: "https://elsewhere.test/" },
        ],
      }),
    ).toEqual({
      named: true,
      cited: true,
      channels: ["cited_source"],
      citedDomains: [
        "elsewhere.test",
        "example.test.attacker.test",
        "journal.example.test",
      ],
    });
    expect(
      parse({
        markdown: "A valid answer",
        sources: [
          {
            title: "Example Studio",
            domain: "example.test",
            url: "https://elsewhere.test/",
          },
        ],
      })?.cited,
    ).toBe(false);
  });
  it("matches domain text and does not match a longer domain", () => {
    expect(parse({ markdown: "Visit www.example.test today" })?.named).toBe(
      true,
    );
    expect(
      parse({ markdown: "Visit example.test.attacker.test today" })?.named,
    ).toBe(false);
  });
  it("reads AI Mode nested references, excluding unrelated result types", () => {
    expect(
      parseMeasurement(
        "ai_mode",
        {
          items: [
            {
              type: "ai_overview",
              markdown: "A valid answer",
              items: [
                {
                  type: "ai_overview_element",
                  references: [{ url: "https://example.test/service" }],
                },
              ],
            },
            {
              type: "organic",
              references: [{ url: "https://unrelated.test/" }],
            },
          ],
        },
        "Example Studio",
        "example.test",
      ),
    ).toEqual({
      named: true,
      cited: true,
      channels: ["cited_source"],
      citedDomains: ["example.test"],
    });
  });
  it("refuses empty and malformed answers instead of measuring zero", () => {
    for (const raw of [
      null,
      {},
      { markdown: " " },
      { markdown: 5 },
      { items: "wrong" },
      { sources: [{ url: "https://example.test/" }] },
      { brand_entities: [{}] },
      {
        items: [
          {
            type: "chat_gpt_local_businesses",
            items: [{ type: "chat_gpt_local_businesses_element" }],
          },
        ],
      },
    ])
      expect(parse(raw)).toBeNull();
  });
});

describe("question-level reports", () => {
  it("never counts errors, timeouts, unparsed or pending answers as measured zero", () => {
    const report = summarizeMeasurements(
      [
        row({ named: true }),
        row({ promptId: "q2", status: "error", named: null }),
        row({ promptId: "q3", status: "timeout", named: null }),
        row({ promptId: "q4", status: "unparsed", named: null }),
        row({ promptId: "q5", status: "posted", named: null }),
      ],
      "chatgpt",
    );
    expect(report).toMatchObject({
      x: 1,
      n: 1,
      status: "too_few_answers",
      band: null,
      excluded: { error: 1, timeout: 1, unparsed: 1, pending: 1 },
    });
    expect(
      summarizeMeasurements([row({ status: "error", named: null })], "chatgpt"),
    ).toMatchObject({ x: 0, n: 0, status: "not_measured", band: null });
  });
  it("uses majority over correlated repeats and Wilson over questions", () => {
    const rows = Array.from({ length: 8 }, (_, i) => [
      row({
        promptId: `q${i}`,
        named: true,
        cited: true,
        citedDomains: ["example.test"],
      }),
      row({ promptId: `q${i}`, named: true }),
      row({ promptId: `q${i}`, named: false }),
    ]).flat();
    const report = summarizeMeasurements(rows, "chatgpt");
    expect(report).toMatchObject({
      x: 8,
      n: 8,
      citedX: 0,
      status: "measured",
      topDomains: [{ domain: "example.test", answers: 8 }],
    });
    expect(report.band?.low).toBeCloseTo(0.6756, 3);
    expect(report.band?.high).toBeCloseTo(1, 5);
    expect(report.questions).toHaveLength(8);
  });
  it("separates engines and resolves two-repeat ties without inflating N", () => {
    const report = summarizeMeasurements(
      [row({ named: true }), row(), row({ engine: "ai_mode", named: true })],
      "chatgpt",
    );
    expect(report).toMatchObject({ x: 0, n: 1 });
  });
  it("rejects impossible Wilson inputs", () => {
    expect(wilson95(0, 0)).toBeNull();
    expect(wilson95(2, 1)).toBeNull();
    expect(wilson95(0, 8)?.high).toBeCloseTo(0.3244, 3);
  });
});
