import { describe, expect, it } from "vitest";
import {
  extractPromptResults,
  formatPromptResultLines,
} from "./aiVisibilityPromptResults";

const run = {
  runId: "run_1",
  completedAt: "2026-09-20T00:00:00.000Z",
  promptSetVersion: 3,
};

function success(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    model: "chatgpt",
    text: "Try Acme Plumbing.",
    citations: [
      {
        url: "https://acme.com/",
        domain: "acme.com",
        title: null,
        matchedBrand: true,
      },
    ],
    brandMentioned: true,
    ...overrides,
  };
}

function detailWith(prompts: unknown[]) {
  return JSON.stringify({ prompts });
}

describe("extractPromptResults", () => {
  it("returns one row per question and model with a summary from the rows", () => {
    const detail = detailWith([
      {
        promptId: "p1",
        prompt: "best plumber",
        results: [
          success({
            nameProbability: 0.92,
            nameSource: "jev",
            nameUnsure: false,
          }),
          success({
            model: "claude",
            brandMentioned: false,
            citations: [{ url: "https://x.com/" }],
          }),
        ],
      },
      {
        promptId: "p2",
        prompt: "cheap plumber",
        results: [success({ model: "claude" })],
      },
    ]);

    const results = extractPromptResults(detail, run);

    expect(results).toMatchObject({ measured: true, ...run });
    expect(results.rows[0]).toEqual({
      promptId: "p1",
      prompt: "best plumber",
      model: "chatgpt",
      status: "success",
      brandMentioned: true,
      nameProbability: 0.92,
      nameSource: "jev",
      nameUnsure: false,
      error: null,
      citations: [
        {
          domain: "acme.com",
          url: "https://acme.com/",
          title: null,
          matchedBrand: true,
        },
      ],
      answer: "Try Acme Plumbing.",
      answerTruncated: false,
    });
    // nameProbability absent on older runs, missing citation fields -> null
    expect(results.rows[1]).toMatchObject({
      nameProbability: null,
      nameSource: null,
      nameUnsure: null,
      citations: [
        {
          domain: null,
          url: "https://x.com/",
          title: null,
          matchedBrand: null,
        },
      ],
    });
    expect(results.summary).toEqual({
      questionsChecked: 2,
      questionsWithBrand: 2,
      namedByModel: { chatgpt: 1, claude: 1 },
    });
    expect(formatPromptResultLines(results)).toEqual([
      "Prompt results (run run_1):",
      "- best plumber: named by chatgpt",
      "- cheap plumber: named by claude",
    ]);
  });

  it("keeps null brandMentioned and error rows as not measured, never false", () => {
    const detail = detailWith([
      {
        promptId: "p1",
        prompt: "q1",
        results: [success({ brandMentioned: null })],
      },
      {
        promptId: "p2",
        prompt: "q2",
        results: [
          {
            status: "error",
            model: "gemini",
            errorCode: "UPSTREAM_ERROR",
            message: "boom",
          },
        ],
      },
      {
        promptId: "p3",
        prompt: "q3",
        error: "Prompt explorer failed",
        results: [],
      },
      { promptId: "p4", prompt: "q4", results: [] },
    ]);

    const results = extractPromptResults(detail, run);

    expect(
      results.rows.map((row) => [row.status, row.brandMentioned, row.error]),
    ).toEqual([
      ["success", null, null],
      ["error", null, "boom"],
      ["error", null, "Prompt explorer failed"],
      ["not_measured", null, null],
    ]);
    expect(results.summary).toEqual({
      questionsChecked: 0,
      questionsWithBrand: 0,
      namedByModel: { chatgpt: 0, gemini: 0 },
    });
    expect(formatPromptResultLines(results)).toContain("- q2: not measured");
  });

  it.each([
    null,
    "",
    "not json",
    '{"source":"dataforseo_llm_mentions"}',
    '{"prompts":"x"}',
  ])(
    "reads missing or old-format detail %j as not measured without throwing",
    (detail) => {
      const results = extractPromptResults(detail, run);
      expect(results).toMatchObject({ measured: false, rows: [] });
      expect(formatPromptResultLines(results)).toEqual([
        "Prompt results (run run_1): not measured",
      ]);
    },
  );

  it("cuts the answer at exactly 1,500 characters", () => {
    const rowFor = (text: string) =>
      extractPromptResults(
        detailWith([
          { promptId: "p1", prompt: "q", results: [success({ text })] },
        ]),
        run,
      ).rows[0];

    expect(rowFor("a".repeat(1500))).toMatchObject({
      answer: "a".repeat(1500),
      answerTruncated: false,
    });
    expect(rowFor("a".repeat(1501))).toMatchObject({
      answer: "a".repeat(1500),
      answerTruncated: true,
    });
  });
});
