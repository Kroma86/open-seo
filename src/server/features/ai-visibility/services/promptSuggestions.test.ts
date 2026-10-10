import { describe, expect, it } from "vitest";

import {
  buildAiVisibilityPrompts,
  parseBusinessLocation,
  pluralizeCategory,
} from "@/server/features/ai-visibility/services/promptSuggestions";

// Regressions from the 19 Sep 2026 audit. The shipped prompt set said
// "Woodstock" with no province: ChatGPT refused and asked which Woodstock,
// Perplexity answered about Woodstock, GEORGIA. A second client's set asked
// about Alberta for a British Columbia broker.
const BLINE = {
  category: "Electrician",
  city: "Woodstock",
  region: "Ontario",
  services: ["EV charger installation", "panel upgrades"],
};

describe("parseBusinessLocation", () => {
  it("expands the stored 'City, XX, CC' form to a full region name", () => {
    expect(parseBusinessLocation("Woodstock, ON, CA")).toEqual({
      city: "Woodstock",
      region: "Ontario",
      country: "CA",
    });
  });

  it("handles a British Columbia project", () => {
    expect(parseBusinessLocation("Vernon, BC, CA")).toEqual({
      city: "Vernon",
      region: "British Columbia",
      country: "CA",
    });
  });

  it("returns null rather than guessing when there is no region", () => {
    expect(parseBusinessLocation("Woodstock")).toBeNull();
  });
});

describe("pluralizeCategory", () => {
  it("uses the noun a customer types", () => {
    expect(pluralizeCategory("Electrician")).toBe("electricians");
    expect(pluralizeCategory("Bakery")).toBe("bakeries");
    expect(pluralizeCategory("Massage therapist")).toBe("massage therapists");
  });
});

describe("buildAiVisibilityPrompts", () => {
  const prompts = buildAiVisibilityPrompts(BLINE);

  it("puts the city AND region in every prompt", () => {
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      expect(p, p).toContain("Woodstock");
      expect(p, p).toContain("Ontario");
    }
  });

  it("asks for the category noun customers type, not a '<x> services' phrase", () => {
    // The discovery prompt must name the practitioner: "best electricians".
    expect(prompts.some((p) => /\bbest electricians\b/i.test(p))).toBe(true);
    // And no prompt may fall back to the "best <something> services" shape
    // that made the shipped set unanswerable. Asserting the SHAPE, not one
    // hardcoded string — a mutation test showed the narrow version passed
    // while the original bug was reintroduced as "best electrician services".
    for (const p of prompts) {
      expect(p, p).not.toMatch(/\b(?:best|top[- ]rated)\s+[\w-]+\s+services\b/i);
    }
  });

  it("never names a region the business did not supply", () => {
    for (const p of prompts) {
      expect(p, p).not.toMatch(/alberta|british columbia|georgia/i);
    }
  });

  it("drops the retail templates that made no sense for a trade", () => {
    for (const p of prompts) {
      expect(p, p).not.toMatch(/worth the drive|open on weekends|typical prices/i);
    }
  });

  it("agrees the indefinite article with the word that follows it", () => {
    // Two bugs in one line. A first draft produced "a electrician" — the
    // article was hardcoded. The fix computed it from the CATEGORY, which then
    // produced "an reliable electrician", because in that template the word
    // after the article is the adjective, not the noun. The article has to
    // agree with whatever word actually follows it, so assert exactly that
    // over several categories rather than pinning one string.
    const sets = [
      prompts,
      buildAiVisibilityPrompts({
        category: "Accountant",
        city: "Vernon",
        region: "British Columbia",
      }),
      buildAiVisibilityPrompts({
        category: "Mortgage broker",
        city: "Vernon",
        region: "British Columbia",
      }),
    ];
    for (const set of sets) {
      for (const p of set) {
        for (const [, article, next] of p.matchAll(/\b(an?) ([a-z]+)/gi)) {
          const expected = /^[aeiou]/i.test(next) ? "an" : "a";
          expect(article.toLowerCase(), `"${article} ${next}" in: ${p}`).toBe(
            expected,
          );
        }
      }
    }
  });

  it("still says 'an electrician', not 'a electrician'", () => {
    expect(prompts.some((p) => /\ban electrician\b/i.test(p))).toBe(true);
  });

  it("emits nothing category-specific that breaks on another category", () => {
    // A first draft asked "which ... offer emergency service?" — sensible for
    // an electrician, nonsense for a mortgage broker. Every stock line must
    // survive being pointed at any local business.
    const broker = buildAiVisibilityPrompts({
      category: "Mortgage broker",
      city: "Vernon",
      region: "British Columbia",
    });
    for (const p of broker) {
      expect(p, p).not.toMatch(/emergency|open on|drive|walk[- ]in|delivery/i);
      expect(p, p).toContain("Vernon, British Columbia");
    }
    expect(broker.some((p) => /\ba mortgage broker\b/i.test(p))).toBe(true);
  });

  it("does not ask who to HIRE for a place you go to or buy from", () => {
    // "What should I look for when hiring a pizza restaurant in Vernon?" is
    // the same category mismatch as the retail templates above, just pointed
    // the other way: the stock lines assume you HIRE the business. A bowling
    // club, a bakery and a furniture store are visited, not hired.
    const venues = ["Pizza restaurant", "Bowling club", "Furniture store"].map(
      (category) =>
        buildAiVisibilityPrompts({
          category,
          city: "Vernon",
          region: "British Columbia",
          kind: "choose",
        }),
    );
    for (const set of venues) {
      expect(set.length).toBeGreaterThan(0);
      for (const p of set) {
        expect(p, p).not.toMatch(/\bhir(?:e|ing)\b/i);
        expect(p, p).not.toMatch(/locals use for/i);
      }
    }
  });

  it("still asks what to look for when hiring a service provider", () => {
    expect(prompts.some((p) => /when hiring an electrician/i.test(p))).toBe(
      true,
    );
  });

  it("asks about the services the business actually sells", () => {
    expect(prompts.some((p) => /EV charger/i.test(p))).toBe(true);
  });

  it("caps at the tracked-prompt limit of 10", () => {
    expect(prompts.length).toBeLessThanOrEqual(10);
  });

  it("drops the advice prompt first when the set is capped", () => {
    // A client with two locations splits one 10-prompt cap between them, so
    // something has to go. The lines that make a model NAME businesses are
    // what we measure with; "what should I look for when hiring..." is advice
    // and usually answers without naming anyone. It goes last, so a cap takes
    // it first.
    const five = buildAiVisibilityPrompts({ ...BLINE, services: [], limit: 5 });
    expect(five).toHaveLength(5);
    expect(five.some((p) => /what should I look for/i.test(p))).toBe(false);
    expect(five.some((p) => /top-rated electricians/i.test(p))).toBe(true);

    const fiveChoose = buildAiVisibilityPrompts({
      category: "Bakery",
      city: "Kelowna",
      region: "British Columbia",
      kind: "choose",
      limit: 5,
    });
    expect(fiveChoose).toHaveLength(5);
    expect(fiveChoose.some((p) => /what makes a good/i.test(p))).toBe(false);
  });

  it("keeps the service prompts ahead of the advice prompt", () => {
    // A business that sells more services than there are slots should spend
    // them on the services, not on the advice line.
    const many = buildAiVisibilityPrompts({
      ...BLINE,
      services: ["EV charger installation", "panel upgrades", "generator installation", "knob and tube rewiring"],
    });
    expect(many.some((p) => /knob and tube/i.test(p))).toBe(true);
    expect(many.indexOf(many.find((p) => /what should I look for/i.test(p))!)).toBe(
      many.length - 1,
    );
  });

  it("emits no duplicates", () => {
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  it("refuses to build a set when the region is unknown", () => {
    expect(() =>
      buildAiVisibilityPrompts({ ...BLINE, region: "" }),
    ).toThrowError(/region/i);
  });
});
