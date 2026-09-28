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
    expect(sent).not.toMatch(/\d|@/);
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

  it("keeps fixed safe terms and the client's own numbered name; other numbers go", () => {
    const sent = withoutContactDetails(
      "For winter 2026\u201327, open 24/7, 7 days a week, LGBTQ2S+ friendly, COVID-19 safe. " +
        "A1 Plumbing and 1-800-GOT-JUNK both serve Vernon.",
      "A1 Plumbing",
    );
    for (const kept of ["24/7", "LGBTQ2S+", "COVID-19", "A1 Plumbing"]) {
      expect(sent).toContain(kept);
    }
    expect(sent).not.toMatch(/2026|\b7 days|1-800/);
  });

  // Grok 4.7 review r2: numbers in every other shape.
  it.each([
    "Visit 2900, Kalamalka Lake Road.",
    "Visit 3101, 30 Ave, Vernon.",
    "Unit 305, 3101 30 Avenue, Vernon.",
    "Suite 200, 123 Main Street, Vernon.",
    "#104, 3101 30 Ave",
    "4-123 Main Street",
    "Find them at 12\u201314 Main Street.",
    "123 1/2 Main Street",
    "Shop: 123 Industrial Circuit.",
    "The yard is at 14 Quail Ridge.",
    "Visit 88 Harvest Gate tomorrow.",
    "Call 250.555.0199 on Main Street",
    "Call 1-800-PLUMBER for a free quote",
    "Postal code V1Y 2B3, Kelowna",
  ])("no number from an address or phone in %s", (text) => {
    const sent = withoutContactDetails(
      text,
      "Truewoods",
      "truewoodstimber.com",
    );
    expect(sent).not.toMatch(/\d/);
  });

  it("cuts a year range but keeps the name next to it", () => {
    const sent = withoutContactDetails(
      "For the 2019\u20132020 season, Lane & Co was busy.",
      "Lane & Co Photography",
    );
    expect(sent).toContain("[number] season, Lane & Co");
  });

  // Grok 4.7 review r3: numbers kept as "years" or glued to letters, and emails
  // spelled without "@".
  it.each([
    "Their office is unit 2014.",
    "Mail to PO Box 2020, Vernon.",
    "The shop is at 2010 Main.",
    "Call ext. 2024 from the lobby.",
    "The showroom is Apt.4 on the main floor.",
    "Office Ste.4 is open.",
    "Ship to Box#7.",
    "Their postcode is EC1A1BB.",
    "Their postcode is EC1A 1BB.",
    "We're upstairs in Unit4, mail goes to POBox12",
  ])("no digit reaches Jev from %s", (text) => {
    expect(
      withoutContactDetails(text, "Truewoods", "truewoodstimber.com"),
    ).not.toMatch(/\d/);
  });

  it.each([
    ["Email info(at)gmail.com for a quote.", /info|gmail/],
    ["Email info (at) gmail (dot) com for a quote.", /info|gmail/],
    ["Email info @ gmail.com for a quote.", /info|gmail/],
    ["See https://example.com/?e=info%40gmail.com today.", /gmail/],
    ["book sales at info . JoesPlumbing . com today", /info|JoesPlumbing/],
    ["email jane *at* example *dot* COM today", /jane|example/],
    ["reach jane {at} example {dot} CA today", /jane|example/],
    [
      "email info at joes plumbing and heating services dotcom today",
      /joes|heating services/,
    ],
    [
      "info at the okanagan valley plumbing and heating company dot com please",
      /okanagan|company/,
    ],
  ])("no email reaches Jev from %s", (text, leak) => {
    expect(withoutContactDetails(text)).not.toMatch(leak);
  });

  it("keeps prose that has 'at' and a full stop", () => {
    expect(withoutContactDetails("Plumbers at your door. Call anytime")).toBe(
      "Plumbers at your door. Call anytime",
    );
  });

  it.each([
    ["A1 Plumbing", "I called A1's Plumbing this morning.", "A1's Plumbing"],
    ["A1 Plumbing", "Locals call them A-1 Plumbing.", "A-1 Plumbing"],
    ["1-800-GOT-JUNK", "Try 1800-GOT-JUNK for hauling.", "1800-GOT-JUNK"],
    ["24 Hour Towing", "Try 24hr towing tonight.", "24hr towing"],
  ])("keeps a variant of the numbered brand %s", (brand, text, kept) => {
    expect(withoutContactDetails(text, brand)).toContain(kept);
  });

  // Grok 4.7 review r4: spelled emails whose domain stays in one token,
  // fullwidth characters, units that start with a brand number, vanity numbers.
  it.each([
    ["Email jane.smith at gmail.com for a quote.", /jane|gmail/],
    ["ping sam at dept.company.co.uk please", /sam|company/],
    ["info at joesplumbing .com", /joesplumbing|\.com/],
    ["Contact info (at) joesplumbing.com today.", /joesplumbing/],
    ["Write to sales [at] example.com please.", /example/],
    ["office *at* citytowing.net thanks", /citytowing/],
    ["user %40 example.com", /example/],
    ["Email sales { at } joesplumbing.com for a quote", /joesplumbing/],
    ["Email info -at- joesplumbing.com for a quote", /joesplumbing/],
    ["Email info\uff20joesplumbing.com for a quote", /joesplumbing/],
    ["info at joesplumbing\uff0ecom today", /joesplumbing/],
  ])("no email reaches Jev from %s", (text, leak) => {
    expect(withoutContactDetails(text, "Joe's Plumbing")).not.toMatch(leak);
  });

  it.each([
    ["24 Hour Towing", "The yard is unit 24B on Main."],
    ["24 Hour Towing", "Suite 24-B is the office."],
    ["12 Oaks Dental", "apartment 12B"],
    ["1-800 GOT JUNK", "Dial 1-800-CALL-NOW now."],
    ["1-800 GOT JUNK", "Don't call 1-800-FLOWERS today."],
  ])(
    "brand %s does not let a unit or vanity number through: %s",
    (brand, text) => {
      expect(withoutContactDetails(text, brand)).not.toMatch(/\d/);
    },
  );

  it.each([
    ["7-Eleven", "7 Eleven is the one.", "7 Eleven"],
    ["1-800-FLOWERS", "Order from 1 800 FLOWERS.", "1 800 FLOWERS"],
    ["5-Star Plumbing", "I'd call 5 Star Plumbing.", "5 Star Plumbing"],
    ["A-1 Plumbing", "Try A 1 Plumbing.", "A 1 Plumbing"],
    [
      "Play 2 Learn 4 Life",
      "Play2Learn4Life runs OT groups.",
      "Play2Learn4Life",
    ],
    [
      "Play 2 Learn 4 Life",
      "Play 2 Learn 4 Life runs OT groups.",
      "Play 2 Learn 4 Life",
    ],
  ])("keeps a spaced or joined numbered brand %s", (brand, text, kept) => {
    expect(withoutContactDetails(text, brand)).toContain(kept);
  });

  it("keeps the client's own website", () => {
    expect(
      withoutContactDetails(
        "See truewoodstimber.com/about for tables.",
        "Truewoods",
        "truewoodstimber.com",
      ),
    ).toContain("truewoodstimber.com/about");
  });

  it("does not keep a phone number just because the brand starts with its digits", () => {
    expect(
      withoutContactDetails("Call 240-555-1234 now.", "24 Hour Towing"),
    ).not.toMatch(/\d{3}/);
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
      expect(performance.now() - t0).toBeLessThan(1000);
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
