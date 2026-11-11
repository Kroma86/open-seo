import { describe, expect, it } from "vitest";
import {
  withoutContactDetails,
  MAX_JEV_ANSWER_CHARS,
} from "./brandNameDecision";

describe("Jev brand and contact variants", () => {
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

  // Grok 4.7 review r9: a spelled address as the first words; an accented
  // domain; "dot-com" as one word.
  it.each([
    [
      "Joe's Plumbing",
      "At joesplumbing dot com you can book a plumber in Kelowna.",
      /joesplumbing|\bcom\b/,
    ],
    [
      "Joe's Plumbing",
      "At gmail dot com you can send a note.",
      /gmail|\bcom\b/,
    ],
    ["Joe's Plumbing", "at: joesplumbing dot com", /joesplumbing|\bcom\b/],
    ["Joe's Plumbing", "(at)joesplumbing(dot)com", /joesplumbing|\bcom\b/],
    [
      "Joe's Plumbing",
      "Email hello at caf\u00e9.com or call (250) 555-0199.",
      /hello|caf|\d/,
    ],
    [
      "Joe's Plumbing",
      "reservations at montr\u00e9al.ca today",
      /reservations|montr/,
    ],
    ["Joe's Plumbing", "info at gmail dot-com please", /info|gmail|dot-com/],
  ])("brand %s: no address reaches Jev from %s", (brand, text, leak) => {
    expect(withoutContactDetails(text, brand)).not.toMatch(leak);
  });

  it("still keeps the brand's own 'At' as the first word", () => {
    const sent = withoutContactDetails(
      "At Home Care is the top pick; see athomecare.com.",
      "At Home Care Inc",
    );
    expect(sent).toContain("At Home Care is the top pick");
    expect(sent).not.toMatch(/athomecare/);
  });

  // Grok 4.7 review r10: a brand word with an inner apostrophe or hyphen
  // after "at"; a dotted brand with accents; apostrophes in a domain.
  it.each([
    [
      "St. John's Plumbing",
      "At St John's Plumbing (stjohnsplumbing.com), you can book same-day service.",
      "St John's Plumbing",
    ],
    [
      "John Smith's Plumbing Inc.",
      "At John Smith's Plumbing (johnsmithsplumbing.com), you can book a plumber today.",
      "John Smith's Plumbing",
    ],
    [
      "City Walk-In Clinic Ltd.",
      "At City Walk-In Clinic, see citywalkinclinic.ca to book.",
      "City Walk-In Clinic",
    ],
    [
      "Mike O'Brien's Auto Body Inc.",
      "At Mike O'Brien's Auto Body, see mikeobriensauto.com for a quote.",
      "Mike O'Brien's Auto Body",
    ],
    [
      "St. John's Plumbing Inc.",
      "At St. John's Plumbing, the dot-com booking page is easy.",
      "St. John's Plumbing",
    ],
    [
      "Sweet Bee's Baskets Ltd",
      "Order at Sweet Bee's Baskets (sweetbeesbaskets.ca) for gifts.",
      "Sweet Bee's Baskets",
    ],
    [
      "Ste. Th\u00e9r\u00e8se Dental",
      "Locals recommend Ste.Th\u00e9r\u00e8se Dental for cleanings.",
      "Ste.Th\u00e9r\u00e8se Dental",
    ],
    [
      "St. J\u00e9r\u00f4me Electric",
      "Try St.J\u00e9r\u00f4me Electric for the repair.",
      "St.J\u00e9r\u00f4me Electric",
    ],
  ])("brand %s: the name as written is kept", (brand, text, kept) => {
    const sent = withoutContactDetails(text, brand);
    expect(sent).toContain(kept);
    expect(sent).not.toMatch(/\.(?:ca|com)\b/);
  });

  it.each([
    ["O'Brien Plumbing Inc.", "Send it to info at o'brien.com today."],
    ["Joe's Plumbing Inc.", "Send it to info at joe's-plumbing.com today."],
  ])("brand %s: an apostrophe domain is still cut", (brand, text) => {
    expect(withoutContactDetails(text, brand)).not.toMatch(/\binfo\b|\.com/);
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
});
