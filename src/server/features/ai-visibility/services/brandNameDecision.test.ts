import { describe, expect, it, vi } from "vitest";

import {
  WEEKLY_JEV_CAP_USD,
  gradeAnswerName,
  jevDecisionBody,
  literalBrandInAnswer,
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
      text: "Truewood Timber & Furniture. ".repeat(4000),
      askJev,
      budget,
    });
    expect(second).toEqual({
      named: false,
      p: null,
      unsure: true,
      source: "matcher_fallback",
    });
    expect(askJev).toHaveBeenCalledTimes(1);
    expect(budget.spentUsd).toBeLessThanOrEqual(WEEKLY_JEV_CAP_USD);
  });

  it.each([
    ["missing Jev", undefined, 0],
    ["weekly cap", jev(0.99), WEEKLY_JEV_CAP_USD],
    ["bad p (NaN)", jev(Number.NaN), 0],
    ["bad p (infinite)", jev(Number.POSITIVE_INFINITY), 0],
    ["bad p (negative)", jev(-0.1), 0],
    ["bad p (above one)", jev(1.1), 0],
  ])(
    "does not count a website alone with %s",
    async (_reason, askJev, spentUsd) => {
      const grade = await gradeAnswerName({
        brand: "TWA Studio",
        website: "twa.studio",
        text: "See [this agency](https://twa.studio/) for help.",
        askJev,
        budget: { spentUsd, capUsd: WEEKLY_JEV_CAP_USD },
      });
      expect(grade).toEqual({
        named: false,
        p: null,
        unsure: true,
        source: "matcher_fallback",
      });
      if (askJev) {
        expect(askJev).toHaveBeenCalledTimes(
          spentUsd === WEEKLY_JEV_CAP_USD ? 0 : 1,
        );
      }
    },
  );

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
          instructions: body.questions.named.instructions,
        },
      },
    });
    expect(body.questions.named.instructions).toContain("missing word");
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
        brand: "TWA Studio",
        website: "twa.studio",
        text: "See [this agency](https://twa.studio/) for help.",
        askJev: down,
        budget,
      });
      expect(grade).toEqual({
        named: false,
        p: null,
        unsure: true,
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
