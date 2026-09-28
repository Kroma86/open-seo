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

  // Grok 4.7 review r5: a digit of the brand used as a house, unit or box
  // number; brand names with "at"; wrapped markers.
  it.each([
    [
      "24 Hour Plumbing",
      "Open late at 24 Pandosy Street, Kelowna. Suite 24, Apt. 24, Unit #24, PO Box 24, ext. 24.",
    ],
    [
      "5 Star Plumbing",
      "The van was outside 5 Ellis Street, Suite 5, Box 5. Try 5-Star Plumbing at 5 Gordon Drive.",
    ],
    [
      "Play 2 Learn 4 Life",
      "Classes run at 2 Rio Drive, Unit 4, Kelowna. PO Box 2 and Box 4.",
    ],
    ["Play 2 Learn 4 Life", "Play 2 Learn 4 Life at 2 Rio Drive."],
    ["A 1 Plumbing", "Shop is 1 Main Street, Unit 1, PO Box 1."],
    ["1 800 Flowers", "Deliver to 1 Main Street or 800 Bernard Avenue."],
    ["1-800-GOT-JUNK", "Pickup was at 18 Harvey Avenue and 180 Banks Road."],
  ])("brand %s: no house, unit or box number reaches Jev", (brand, text) => {
    const sent = withoutContactDetails(text, brand);
    expect(sent.replace(/Play 2 Learn 4 Life|5-Star/g, "")).not.toMatch(/\d/);
  });

  it.each([
    [
      "At Home Care Inc",
      "Try At Home Care, details at homecare.com today.",
      "At Home Care",
    ],
    [
      "Photos at the Park Photography",
      "For weddings, Photos at the Park (photosatthepark.com) is the one locals name.",
      "Photos at the Park",
    ],
  ])("keeps a brand that contains 'at': %s", (brand, text, kept) => {
    const sent = withoutContactDetails(text, brand);
    expect(sent).toContain(kept);
    expect(sent).not.toMatch(/homecare\.com|photosatthepark\.com/);
  });

  it.each([
    "Email info at joesplumbing [.] com for a quote",
    "Email info at joesplumbing(.)com for a quote",
    "Email info at joesplumbing{dot}com for a quote",
    "Email info (@) joesplumbing dot com for a quote",
    "Email info /at/ joesplumbing /dot/ com today",
  ])("no wrapped-marker email reaches Jev: %s", (text) => {
    expect(withoutContactDetails(text)).not.toMatch(/joesplumbing|\binfo\b/);
  });

  // Grok 4.7 review r6: a letter unit that starts like the brand; the
  // brand's own spelling right before "at <domain>".
  it.each([
    [
      "2 Brothers Plumbing",
      "Their shop is in suite 2B on Richter. Also unit #2B and unit 2-B.",
    ],
    ["1st Choice Plumbing", "They are in suite 1S."],
    ["24 Hour Glass", "Workshop is unit 24H, 1500 Pandosy."],
    ["5 Star Plumbing", "Find them in suite 5S."],
    ["4 All Seasons", "Suite 4A, 100 Main."],
    ["A 1 Plumbing", "Their office is Suite A1 downtown."],
  ])("brand %s: a letter unit number does not reach Jev", (brand, text) => {
    expect(withoutContactDetails(text, brand)).not.toMatch(/\d/);
  });

  it.each([
    ["24 Hour", "I would contact 24-Hour at 24hour.ca", "24-Hour"],
    ["Play 2 Learn", "Check out Play2Learn at play2learn.com", "Play2Learn"],
    ["U Haul", "Reserve U-Haul at uhaul.com", "U-Haul"],
    ["O'Brien Photography", "Hire O'Brien at obrien.com", "O'Brien"],
    ["Studio 24 Photography", "Book Studio 24 at studio24.com", "Studio 24"],
    ["Route 66 Associates", "Try Route 66 at route66.com", "Route 66"],
    ["Highway 97 Inc", "Reach Highway 97 at highway97.com", "Highway 97"],
    ["A 1 Plumbing", "Call A1 Plumbing, the locals' pick.", "A1 Plumbing"],
    [
      "Play 2 Learn 4 Life",
      "Play 2 Learn 4 Life at play2learn4life.ca is popular.",
      "Play 2 Learn 4 Life",
    ],
  ])("brand %s: its own spelling before 'at' is kept", (brand, text, kept) => {
    const sent = withoutContactDetails(text, brand);
    expect(sent).toContain(kept);
    expect(sent).not.toMatch(/\.(?:ca|com)\b/);
  });

  it("still cuts the name part of a spelled email next to the brand", () => {
    const sent = withoutContactDetails(
      "Email bookings at play2learn dot com or jen24 at gmail.com",
      "Play 2 Learn",
    );
    expect(sent).not.toMatch(/bookings|jen|gmail|\d/);
  });

  // Grok 4.7 review r7: next word only the tail of a brand word; a brand
  // with "at"; a glued brand written spaced.
  it.each([
    [
      "24 Hour Glass",
      "The workshop is unit 24H. Our staff opens early. Or unit 24-H, our staff.",
    ],
    ["3 Sons Plumbing", "They work out of suite 3S on Bernard Avenue."],
    [
      "1 Stop Plumbing",
      "The office is suite 1S. Top reviews mention same-day service.",
    ],
    ["1 Call Plumbing", "The shop is unit 1C. All reviews mention speed."],
  ])(
    "brand %s: a unit is cut even when the next word ends a brand word",
    (brand, text) => {
      expect(withoutContactDetails(text, brand)).not.toMatch(/\d/);
    },
  );

  it.each([
    [
      "At Home Care",
      "Email the coordinator at sarah at gmail dot com and they will call you back.",
    ],
    ["At Home Care", "Write hello(at)gmail(dot)com for a quote."],
    [
      "Eat at Joe's",
      "You should email them at bob at gmail dot com for a table.",
    ],
    ["Photos at the Park", "Photos at the Park: write jen at gmail dot com."],
  ])("brand %s: a spelled email is still cut", (brand, text) => {
    expect(withoutContactDetails(text, brand)).not.toMatch(
      /sarah|hello|bob|jen|gmail/,
    );
  });

  it.each([
    ["Eat at Joe's", "Try Eat at Joe's downtown.", "Eat at Joe's"],
    [
      "At Home Care",
      "Try At Home Care, details at homecare.com today.",
      "At Home Care",
    ],
    ["A1 Plumbing", "I'd recommend A 1 Plumbing for the job.", "A 1 Plumbing"],
    ["Play2Learn", "Look at Play 2 Learn for toddler classes.", "Play 2 Learn"],
    ["24Hour Glass", "Book 24 Hour Glass for the storefront.", "24 Hour Glass"],
    ["H2O Plumbing", "Ask for H 2 O Plumbing on the phone.", "H 2 O Plumbing"],
    ["A 1 Plumbing", "Call A1 Plumbing, the locals' pick.", "A1 Plumbing"],
  ])("brand %s: the name as written is kept", (brand, text, kept) => {
    expect(withoutContactDetails(text, brand)).toContain(kept);
  });

  // Grok 4.7 review r8: the brand's own "at" before a spelled dot; half a
  // postal code shaped like the brand; the brand written after "at".
  it.each([
    [
      "At Home Care",
      "Email the coordinator at home dot com for a quote.",
      /coordinator|home|\bcom\b/,
    ],
    ["At Home Care", "hello(at)home(dot)com", /hello|home|\bcom\b/],
    [
      "At Home Care",
      "info at home dot com or 250-555-0199",
      /info|home|\bcom\b|\d/,
    ],
    [
      "Photos at the Park",
      "Book a session at the park dot com this week.",
      /session|park|\bcom\b/,
    ],
    [
      "Coffee at Main",
      "Say hello at main dot com for hours.",
      /hello|main|\bcom\b/,
    ],
  ])(
    "brand %s: a spelled address after its own 'at' is cut",
    (brand, text, leak) => {
      expect(withoutContactDetails(text, brand)).not.toMatch(leak);
    },
  );

  it.each([
    [
      "A1 Appliance Repair",
      "They are downtown near the harbour, postal code A1A 1A1.",
    ],
    ["S1 Auto Body", "Regina, SK S1A 0H1"],
    ["T2 Plumbing", "Calgary, AB T2P 1B5"],
    ["V1 Electric", "Vernon, BC V1T 6L4"],
  ])("brand %s: no half of a postal code reaches Jev", (brand, text) => {
    expect(withoutContactDetails(text, brand)).not.toMatch(/\d/);
  });

  it.each([
    [
      "A 1 Plumbing",
      "You will find them at A1 Plumbing (a1plumbing.com).",
      "A1 Plumbing",
    ],
    [
      "A 1 Plumbing",
      "Ask the people at A1 Plumbing instead of a dot com directory.",
      "A1 Plumbing",
    ],
    [
      "Play 2 Learn",
      "The teachers at Play2Learn beat any dot com program.",
      "Play2Learn",
    ],
    [
      "24 Hour Glass",
      "Book at 24-Hour Glass via 24hourglass.com today.",
      "24-Hour Glass",
    ],
    [
      "H 2 O Plumbing",
      "Call the techs at H2O Plumbing, see h2oplumbing.com.",
      "H2O Plumbing",
    ],
    [
      "Al's Appliance Inc.",
      "Get a quote at Al's Appliance (alsappliance.ca).",
      "Al's Appliance",
    ],
    [
      "Photos at the Park",
      "For weddings, Photos at the Park (photosatthepark.com) is the one locals name.",
      "Photos at the Park",
    ],
  ])("brand %s: its name after 'at' is kept", (brand, text, kept) => {
    const sent = withoutContactDetails(text, brand);
    expect(sent).toContain(kept);
    expect(sent).not.toMatch(/\.(?:ca|com)\b/);
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
