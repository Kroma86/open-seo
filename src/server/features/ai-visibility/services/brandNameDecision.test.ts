import { describe, expect, it, vi } from "vitest";

import {
  WEEKLY_JEV_CAP_USD,
  gradeAnswerName,
  jevDecisionBody,
  literalBrandInAnswer,
  withoutContactDetails,
  MAX_JEV_ANSWER_CHARS,
  MAX_JEV_FAILURES,
  type JevDecisionBody,
  type JevNamedAnswer,
} from "@/server/features/ai-visibility/services/brandNameDecision";

const JACE = "Jace-Xteriors";

function jev(p: number, costUsd = 0.00004) {
  return vi.fn(
    async (_body: JevDecisionBody): Promise<JevNamedAnswer> => ({ p, costUsd }),
  );
}

describe("gradeAnswerName", () => {
  it("counts a literal brand and does not ask Jev", async () => {
    const askJev = jev(0);
    const grade = await gradeAnswerName({
      brand: JACE,
      website: "jacexteriors.net",
      text: "Jace-Xteriors is based in the Okanagan.",
      askJev,
    });
    expect(grade).toEqual({
      named: true,
      p: null,
      unsure: false,
      source: "literal",
    });
    expect(askJev).not.toHaveBeenCalled();
  });

  it("counts a non-breaking hyphen as the same brand and does not ask Jev", async () => {
    const askJev = jev(0);
    const text = "We found \u201cJace\u2011Xteriors\u201d in Lumby.";
    expect(literalBrandInAnswer(text, JACE)).toBe(true);
    const grade = await gradeAnswerName({
      brand: JACE,
      website: "jacexteriors.net",
      text,
      askJev,
    });
    expect(grade.source).toBe("literal");
    expect(grade.named).toBe(true);
    expect(askJev).not.toHaveBeenCalled();
  });

  it("asks Jev for a shortened name and counts it when p is at least 0.5", async () => {
    const askJev = jev(0.97);
    const grade = await gradeAnswerName({
      brand: "Al's Appliance Repair",
      website: "alsappliance.ca",
      text: "Al's Appliance Inc. serves Kitchener.",
      askJev,
    });
    expect(askJev).toHaveBeenCalledTimes(1);
    const body = askJev.mock.calls[0][0];
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.provider).toEqual({ zdr: true });
    expect(body.questions.named.type).toBe("noul");
    expect(body.questions.named.instructions).toContain(
      "Do NOT count a different business",
    );
    expect(body.state.business).toEqual({
      name: "Al's Appliance Repair",
      website: "alsappliance.ca",
    });
    expect(grade).toMatchObject({
      named: true,
      p: 0.97,
      unsure: false,
      source: "jev",
    });
  });

  it("does not count Hunter Exteriors for Jace-Xteriors", async () => {
    const askJev = jev(0.04);
    const text =
      "Hunter Exteriors lists Lumby among its service areas. See https://jacexteriors.net/locations/vernon";
    expect(literalBrandInAnswer(text, JACE)).toBe(false);
    const grade = await gradeAnswerName({
      brand: JACE,
      website: "jacexteriors.net",
      text,
      askJev,
      fallbackNamed: true,
    });
    expect(askJev).toHaveBeenCalledTimes(1);
    expect(grade.named).toBe(false);
    expect(grade.p).toBe(0.04);
    expect(grade.unsure).toBe(false);
    expect(grade.source).toBe("jev");
  });

  it("flags an unsure probability without treating it as a third score", async () => {
    const high = await gradeAnswerName({
      brand: "Truewoods",
      website: "truewoodstimber.com",
      text: "Truewood Timber & Furniture is in Stony Plain.",
      askJev: jev(0.62),
    });
    expect(high).toMatchObject({ named: true, unsure: true, p: 0.62 });
    const low = await gradeAnswerName({
      brand: "Truewoods",
      website: "truewoodstimber.com",
      text: "Truewood Timber & Furniture is in Stony Plain.",
      askJev: jev(0.4),
    });
    expect(low).toMatchObject({ named: false, unsure: true, p: 0.4 });
  });

  it("folds a curly apostrophe before the literal check", () => {
    expect(
      literalBrandInAnswer(
        "Call Al\u2019s Appliance Repair today.",
        "Al's Appliance Repair",
      ),
    ).toBe(true);
  });

  it("stops asking Jev once the weekly cap would be crossed", async () => {
    const askJev = jev(0.99, WEEKLY_JEV_CAP_USD - 0.00001);
    const budget = { spentUsd: 0, capUsd: WEEKLY_JEV_CAP_USD };
    const first = await gradeAnswerName({
      brand: "Truewoods",
      website: "truewoodstimber.com",
      text: "Truewood Timber & Furniture.",
      askJev,
      budget,
    });
    expect(first.source).toBe("jev");
    expect(budget.spentUsd).toBeCloseTo(WEEKLY_JEV_CAP_USD - 0.00001);
    const second = await gradeAnswerName({
      brand: "Truewoods",
      website: "truewoodstimber.com",
      text: `${"Truewood Timber & Furniture. ".repeat(4000)}`,
      askJev,
      fallbackNamed: false,
      budget,
    });
    expect(second.source).toBe("matcher_fallback");
    expect(second.named).toBe(false);
    expect(askJev).toHaveBeenCalledTimes(1);
    expect(budget.spentUsd).toBeLessThanOrEqual(WEEKLY_JEV_CAP_USD);
  });

  it("builds the decisions body the ticket specifies", () => {
    const body = jevDecisionBody(
      "Tyne Buchy",
      "tynebuchyrcc.com",
      "Tyne Buchy, RCC",
    );
    expect(body).toEqual({
      model: "typesafe/jev-1.13",
      provider: { zdr: true },
      state: {
        business: { name: "Tyne Buchy", website: "tynebuchyrcc.com" },
        ai_answer: "Tyne Buchy, RCC",
      },
      questions: {
        named: {
          type: "noul",
          instructions: expect.any(String),
        },
      },
    });
    expect(body.questions.named.instructions).toContain("missing word");
  });

  it("never sends Jev a phone number, email address or house number", () => {
    const text =
      "Call Al\u2019s Appliance Inc. at (250) 545-1234 or +1 778 776 7060, " +
      "email info@alsappliance.ca, or visit 3101 30 Ave or 2900 Kalamalka Lake Road.";
    const sent = jevDecisionBody(
      "Al's Appliance Repair",
      "alsappliance.ca",
      text,
    ).state.ai_answer;
    expect(sent).toContain("Al\u2019s Appliance Inc.");
    expect(sent).not.toMatch(/545|1234|776|7060|@|3101|2900/);
    expect(sent).toContain("[phone]");
    expect(sent).toContain("[email]");
    expect(sent).toContain("[number] Kalamalka Lake Road");
  });

  // Grok 4.7 review r1: numbers written with Unicode dashes, and lower-case
  // or longer street lines, slipped through.
  it.each([
    ["Call (250) 545\u20111234 today.", /545|1234/],
    ["Call 250\u2013545\u20131234 today.", /545|1234/],
    ["Call 250\u2010545\u20101234 today.", /545|1234/],
    ["Call 250-545\u20111234 today.", /545|1234/],
    ["Call 250\u2212545\u22121234 today.", /545|1234/],
    ["Visit 2900 kalamalka lake road tomorrow.", /2900/],
    ["Visit 3101 30 ave tomorrow.", /3101/],
    ["Visit 123 main street tomorrow.", /123/],
    ["Visit 12 O\u2019Brien Street tomorrow.", /\b12\b/],
    ["Visit 2900 North West Kalamalka Lake Road.", /2900/],
  ])("removes contact details from %s", (text, leak) => {
    expect(withoutContactDetails(text)).not.toMatch(leak);
  });

  it("keeps years, prices and plain prose that only look like numbers", () => {
    const sent = withoutContactDetails(
      "For winter 2026\u201327, expect $1,200 per season; 3 ways to go the extra mile.",
    );
    expect(sent).toContain("2026-27");
    expect(sent).toContain("$1,200");
    expect(sent).toContain("3 ways to go the extra mile");
  });

  // Grok 4.7 review r1: removing a whole address line took the client's own
  // name with it, so "a missing word like Inc" could never count.
  it.each([
    [
      "You'll want 1200 Setanta Landscapes Way in Vernon.",
      "Setanta Landscapes Way",
    ],
    [
      "I'd call them \u2014 55 Main Street Auto is the one.",
      "Main Street Auto",
    ],
    ["Since 2019 Lane & Co has served Vernon.", "Lane & Co"],
    ["Hire the #1 Place Roofing in Vernon.", "Place Roofing"],
    [
      "Since 1998 Trail Side Timber has worked the valley.",
      "Trail Side Timber",
    ],
  ])("keeps the business name in %s", (text, name) => {
    expect(withoutContactDetails(text)).toContain(name);
  });

  it("redacts a very long answer quickly and caps what Jev sees", () => {
    for (const text of [
      "a".repeat(200_000),
      "1".repeat(200_000),
      "a@".repeat(100_000),
    ]) {
      const t0 = performance.now();
      const sent = withoutContactDetails(text);
      expect(performance.now() - t0).toBeLessThan(250);
      expect(sent.length).toBeLessThanOrEqual(MAX_JEV_ANSWER_CHARS);
    }
  });

  it("stops asking Jev after 3 failed calls in a row, and a success resets the count", async () => {
    const budget = { spentUsd: 0, capUsd: WEEKLY_JEV_CAP_USD };
    const down = vi.fn(
      async (_body: JevDecisionBody): Promise<JevNamedAnswer> => {
        throw new Error("jev_timeout");
      },
    );
    for (let i = 0; i < 6; i += 1) {
      const grade = await gradeAnswerName({
        brand: "Truewoods",
        website: "truewoodstimber.com",
        text: "Truewood Timber & Furniture.",
        askJev: down,
        fallbackNamed: true,
        budget,
      });
      expect(grade).toEqual({
        named: true,
        p: null,
        unsure: false,
        source: "matcher_fallback",
      });
    }
    expect(down).toHaveBeenCalledTimes(MAX_JEV_FAILURES);
    expect(budget.spentUsd).toBe(0);

    const flaky = { spentUsd: 0, capUsd: WEEKLY_JEV_CAP_USD, failures: 2 };
    const ok = jev(0.97);
    const grade = await gradeAnswerName({
      brand: "Truewoods",
      website: "truewoodstimber.com",
      text: "Truewood Timber & Furniture.",
      askJev: ok,
      budget: flaky,
    });
    expect(grade.source).toBe("jev");
    expect(flaky.failures).toBe(0);
  });

  it("still counts a literal brand that sits inside an address line", async () => {
    const askJev = jev(0);
    const grade = await gradeAnswerName({
      brand: "Setanta Landscapes",
      website: "setantalandscapes.ca",
      text: "Setanta Landscapes, 1200 Setanta Landscapes Way, Vernon",
      askJev,
    });
    expect(grade.source).toBe("literal");
    expect(askJev).not.toHaveBeenCalled();
  });
});
