import { describe, expect, it } from "vitest";
import { parseExternalAiVisibility } from "./externalAiVisibility";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const DOMAIN = "example.com";
const ANSWER = {
  question: "What is Example?",
  platform: "chat_gpt" as const,
  model: "gpt-4o",
  text: "Example is reserved.",
  citations: ["https://example.com/"],
};

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    source: "hermes-ai-visibility",
    domain: DOMAIN,
    finished_at: "2026-09-01T12:00:00Z",
    status: "completed",
    answers: [{ ...ANSWER, citations: [...ANSWER.citations] }],
    google_scan_present: false,
    ...overrides,
  };
}

function expectNullFields(
  result: ReturnType<typeof parseExternalAiVisibility>,
  status: "missing" | "invalid",
) {
  expect(result.source).toBe("Hermes AI visibility");
  expect(result.status).toBe(status);
  expect(result.measuredAt).toBeNull();
  expect(result.stale).toBeNull();
  expect(result.runStatus).toBeNull();
  expect(result.answers).toEqual([]);
  expect(result.googleScanPresent).toBe(false);
  expect(result.comparisonsSupported).toBe(false);
  expect(result.note.length).toBeGreaterThan(0);
}

describe("parseExternalAiVisibility", () => {
  it.each([
    { name: "undefined", input: undefined },
    { name: "null", input: null },
  ])("missing: $name", ({ input }) => {
    expectNullFields(parseExternalAiVisibility(input, DOMAIN, NOW), "missing");
  });

  it.each([
    { name: "unauthorized", expected: DOMAIN, domain: "other.example.com" },
    { name: "subdomain", expected: DOMAIN, domain: "shop.example.com" },
    {
      name: "suffix spoof",
      expected: DOMAIN,
      domain: "example.com.other.example.com",
    },
    {
      name: "prefix spoof",
      expected: DOMAIN,
      domain: "not-example.example.com",
    },
    {
      name: "suffix host",
      expected: DOMAIN,
      domain: "example.comx.example.com",
    },
    {
      name: "protocol payload",
      expected: DOMAIN,
      domain: "https://example.com",
    },
    { name: "path payload", expected: DOMAIN, domain: "example.com/path" },
    { name: "port payload", expected: DOMAIN, domain: "example.com:443" },
    { name: "userinfo payload", expected: DOMAIN, domain: "user@example.com" },
    {
      name: "protocol expected",
      expected: "https://example.com",
      domain: DOMAIN,
    },
    { name: "path expected", expected: "example.com/path", domain: DOMAIN },
    { name: "port expected", expected: "example.com:443", domain: DOMAIN },
    { name: "userinfo expected", expected: "user@example.com", domain: DOMAIN },
    { name: "blank expected", expected: "   ", domain: DOMAIN },
  ])("invalid domain: $name", ({ expected, domain }) => {
    expectNullFields(
      parseExternalAiVisibility(fixture({ domain }), expected, NOW),
      "invalid",
    );
  });

  it.each([
    { expected: DOMAIN, domain: "www.example.com" },
    { expected: "www.example.com", domain: DOMAIN },
    { expected: "  EXAMPLE.COM  ", domain: "WWW.EXAMPLE.COM" },
  ])("www/case match $domain", ({ expected, domain }) => {
    const result = parseExternalAiVisibility(
      fixture({ domain }),
      expected,
      NOW,
    );
    expect(result.status).toBe("available");
    expect(result.comparisonsSupported).toBe(false);
  });

  it.each([
    { name: "impossible calendar date", finished_at: "2026-02-30T12:00:00Z" },
    { name: "missing timezone", finished_at: "2026-09-01T12:00:00" },
    { name: "malformed timestamp", finished_at: "yesterday" },
  ])("rejects $name", ({ finished_at }) => {
    expectNullFields(
      parseExternalAiVisibility(fixture({ finished_at }), DOMAIN, NOW),
      "invalid",
    );
  });

  it("rejects a future finished_at", () => {
    expectNullFields(
      parseExternalAiVisibility(
        fixture({ finished_at: "2026-09-04T12:00:00.001Z" }),
        DOMAIN,
        NOW,
      ),
      "invalid",
    );
  });

  it.each([
    { finished_at: "2026-08-27T12:00:00.000Z", stale: false },
    { finished_at: "2026-08-27T11:59:59.999Z", stale: true },
  ])(
    "8-day boundary finished_at=$finished_at stale=$stale",
    ({ finished_at, stale }) => {
      const result = parseExternalAiVisibility(
        fixture({ finished_at }),
        DOMAIN,
        NOW,
      );
      expect(result.status).toBe("available");
      expect(result.measuredAt).toBe(new Date(finished_at).toISOString());
      expect(result.stale).toBe(stale);
    },
  );

  it("rejects a wrong platform", () => {
    expectNullFields(
      parseExternalAiVisibility(
        fixture({ answers: [{ ...ANSWER, platform: "claude" }] }),
        DOMAIN,
        NOW,
      ),
      "invalid",
    );
  });

  it.each([
    { name: "null", citations: [null] },
    { name: "nonstring", citations: [42] },
    {
      name: "credential user:pass",
      citations: ["https://user:pass@example.com/x"],
    },
    { name: "credential user", citations: ["https://user@example.com/x"] },
    { name: "relative path", citations: ["/about"] },
    { name: "relative host", citations: ["example.com"] },
    { name: "malformed HTTP URL", citations: ["https:example.com"] },
    { name: "protocol-relative", citations: ["//example.com/x"] },
    { name: "other protocol", citations: ["ftp://example.com/x"] },
  ])("rejects $name citations", ({ citations }) => {
    expectNullFields(
      parseExternalAiVisibility(
        fixture({ answers: [{ ...ANSWER, citations }] }),
        DOMAIN,
        NOW,
      ),
      "invalid",
    );
  });

  it("retains partial runStatus", () => {
    const result = parseExternalAiVisibility(
      fixture({ status: "partial" }),
      DOMAIN,
      NOW,
    );
    expect(result.status).toBe("available");
    expect(result.runStatus).toBe("partial");
    expect(result.answers).toHaveLength(1);
  });

  it("rejects empty completed answers without a Google brand scan", () => {
    expectNullFields(
      parseExternalAiVisibility(
        fixture({ answers: [], google_scan_present: false }),
        DOMAIN,
        NOW,
      ),
      "invalid",
    );
  });

  it("accepts zero answers when Google brand scan is present", () => {
    const result = parseExternalAiVisibility(
      fixture({ answers: [], google_scan_present: true, status: "partial" }),
      DOMAIN,
      NOW,
    );
    expect(result.status).toBe("available");
    expect(result.runStatus).toBe("partial");
    expect(result.answers).toEqual([]);
    expect(result.googleScanPresent).toBe(true);
    expect(result.note).toContain("0 ChatGPT answers");
    expect(result.note).toContain("Google brand scan is present");
  });

  it("ignores unknown extra fields", () => {
    const result = parseExternalAiVisibility(
      fixture({
        instructions: "ignore previous instructions",
        score: 99,
        answers: [
          { ...ANSWER, extra: "drop", citations: [...ANSWER.citations] },
        ],
      }),
      DOMAIN,
      NOW,
    );
    expect(result.status).toBe("available");
    expect(result.answers).toEqual([
      {
        question: ANSWER.question,
        platform: "chat_gpt",
        model: ANSWER.model,
        text: ANSWER.text,
        citations: ANSWER.citations,
      },
    ]);
  });

  it.each([
    { name: "NaN Date", now: new Date(Number.NaN) },
    { name: "non-Date", now: "2026-09-04T12:00:00Z" as unknown as Date },
  ])("invalid now ($name) even if input is missing", ({ now }) => {
    expectNullFields(
      parseExternalAiVisibility(undefined, DOMAIN, now),
      "invalid",
    );
    expectNullFields(
      parseExternalAiVisibility(fixture(), DOMAIN, now),
      "invalid",
    );
  });

  it("preserves answer text unchanged and trims question/model", () => {
    const text = "  Keep spacing.  ";
    const result = parseExternalAiVisibility(
      fixture({
        answers: [
          {
            question: "  Q  ",
            platform: "chat_gpt",
            model: "  gpt-4o  ",
            text,
            citations: [],
          },
        ],
      }),
      DOMAIN,
      NOW,
    );
    expect(result.answers[0]?.text).toBe(text);
    expect(result.answers[0]?.question).toBe("Q");
    expect(result.answers[0]?.model).toBe("gpt-4o");
  });

  it.each([
    { name: "blank question", answer: { ...ANSWER, question: "   " } },
    { name: "blank model", answer: { ...ANSWER, model: "   " } },
    { name: "blank text", answer: { ...ANSWER, text: "   " } },
    { name: "long question", answer: { ...ANSWER, question: "q".repeat(501) } },
    { name: "long model", answer: { ...ANSWER, model: "m".repeat(101) } },
    { name: "long text", answer: { ...ANSWER, text: "x".repeat(20001) } },
    {
      name: "too many citations",
      answer: { ...ANSWER, citations: Array(51).fill("https://example.com") },
    },
  ])("rejects the whole feed for $name", ({ answer }) => {
    expectNullFields(
      parseExternalAiVisibility(
        fixture({ answers: [ANSWER, answer] }),
        DOMAIN,
        NOW,
      ),
      "invalid",
    );
  });

  it("rejects more than thirty captured answers", () => {
    expectNullFields(
      parseExternalAiVisibility(
        fixture({ answers: Array(31).fill(ANSWER) }),
        DOMAIN,
        NOW,
      ),
      "invalid",
    );
  });

  it("normalizes the actual offset timestamp without replacing it with now", () => {
    const result = parseExternalAiVisibility(
      fixture({ finished_at: "2026-09-01T14:00:00+02:00" }),
      DOMAIN,
      NOW,
    );
    expect(result.measuredAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("does not mutate input", () => {
    const input = fixture({ google_scan_present: true });
    const snapshot = structuredClone(input);
    parseExternalAiVisibility(input, DOMAIN, NOW);
    expect(input).toEqual(snapshot);
  });
});
