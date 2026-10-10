import { describe, expect, it } from "vitest";

import {
  citationMatchesBrand,
  textMentionsBrand,
} from "@/server/features/ai-search/services/brandMatch";

// Real capture, 19 Sep 2026: Perplexity ranked this client FIRST for
// "Who are the best electricians in Woodstock, Ontario?" but the board scored
// the project 0/10. The model renders the hyphen as U+2011 NON-BREAKING
// HYPHEN, so a literal match against the ASCII-hyphen brand missed it.
const PERPLEXITY_ANSWER =
  "The most consistently recommended electricians in **Woodstock, Ontario** " +
  "include **B‑Line Electrical Services**, **Dueck Electric Ltd**, " +
  "**Hawkins Electric Inc**, and **Somerton Electric**.";

describe("textMentionsBrand", () => {
  it("matches a brand the model wrote with a non-breaking hyphen", () => {
    expect(
      textMentionsBrand(PERPLEXITY_ANSWER, "B-Line Electrical Services"),
    ).toBe(true);
  });

  it("matches across the other unicode dashes models emit", () => {
    for (const dash of ["‐", "‒", "–", "—", "−"]) {
      expect(
        textMentionsBrand(`We recommend B${dash}Line Electrical Services.`, "B-Line Electrical Services"),
        `dash U+${dash.codePointAt(0)!.toString(16)}`,
      ).toBe(true);
    }
  });

  it("tolerates punctuation the model drops from the registered name", () => {
    expect(
      textMentionsBrand(
        "Try Greenaway Theis & Associates in Guelph.",
        "Greenaway, Theis & Associates",
      ),
    ).toBe(true);
  });

  it("matches a curly apostrophe against a straight one", () => {
    expect(textMentionsBrand("Call Lloyd’s Electric.", "Lloyd's Electric")).toBe(
      true,
    );
  });

  it("matches across a non-breaking space", () => {
    expect(textMentionsBrand("Klean Co. cleans homes.", "Klean Co.")).toBe(
      true,
    );
  });

  it("does not match a different business with a similar name", () => {
    expect(
      textMentionsBrand(
        "Bline Electrical Supply sells parts.",
        "B-Line Electrical Services",
      ),
    ).toBe(false);
  });

  it("does not match the brand inside a longer word", () => {
    expect(textMentionsBrand("Kleanser Company products.", "Klean Co.")).toBe(
      false,
    );
  });

  it("reports a genuine absence as false, not true", () => {
    expect(
      textMentionsBrand(
        "Jackson Electric Inc. and Hatfield Electric are well reviewed.",
        "B-Line Electrical Services",
      ),
    ).toBe(false);
  });
});

describe("citationMatchesBrand", () => {
  it("matches the brand in a citation title with a unicode dash", () => {
    expect(
      citationMatchesBrand(
        "https://blineelectric.ca/",
        "Electrician in Woodstock, ON | B‑Line Electrical Services",
        "B-Line Electrical Services",
      ),
    ).toBe(true);
  });

  it("does not match an unrelated citation", () => {
    expect(
      citationMatchesBrand(
        "https://www.hatfieldelectric.ca/",
        "Hatfield Electric | Woodstock Electrician",
        "B-Line Electrical Services",
      ),
    ).toBe(false);
  });

  it("returns false when no brand is supplied", () => {
    expect(citationMatchesBrand("https://x.test/", "X", null)).toBe(false);
  });
});
