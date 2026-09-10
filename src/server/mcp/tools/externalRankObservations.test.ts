import { describe, expect, it } from "vitest";
import { parseExternalRankObservations } from "./externalRankObservations";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const AT = "2026-09-03T09:00:00.000Z";
type Raw = Record<string, unknown>;
const obs = (patch: Raw = {}): Raw => ({
  keyword: "blue widgets",
  country: "US",
  position: 3,
  url: "https://example.com/blue",
  checked_at: AT,
  ...patch,
});
const feed = (observations: unknown[], patch: Raw = {}): Raw => ({
  source: "hermes-rank-history",
  observations,
  ...patch,
});
const parse = (payload: unknown, now = NOW) =>
  parseExternalRankObservations(payload, now);
const rows = (observations: unknown[]) => parse(feed(observations));

function expectEmpty(
  payload: unknown,
  status: "missing" | "invalid",
  now = NOW,
) {
  expect(parse(payload, now)).toMatchObject({
    source: "Hermes daily rank checks",
    status,
    updatedAt: null,
    stale: null,
    method: "unspecified",
    comparisonsSupported: false,
    rows: [],
  });
}

describe("parseExternalRankObservations", () => {
  it("normalizes source timestamps and sorts valid observations", () => {
    const result = rows([
      obs({
        keyword: "  Red Widgets  ",
        country: " de ",
        position: null,
        url: null,
        checked_at: "2026-09-04T08:30:00+02:00",
        extra: "ignored",
      }),
      obs(),
    ]);
    expect(result.status).toBe("available");
    expect(result.updatedAt).toBe("2026-09-04T06:30:00.000Z");
    expect(
      result.rows.map(({ keyword, country }) => [keyword, country]),
    ).toEqual([
      ["blue widgets", "US"],
      ["Red Widgets", "de"],
    ]);
  });

  it("retains the newest values and deterministic capitalization", () => {
    const observations = [
      obs({ position: 9, checked_at: "2026-09-01T09:00:00Z" }),
      obs({ keyword: "Blue Widgets", country: " us ", position: 4 }),
      obs({ position: 4, checked_at: "2026-09-03T11:00:00+02:00" }),
    ];
    const result = rows(observations);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      keyword: "Blue Widgets",
      country: "US",
      position: 4,
    });
    expect(rows([...observations].reverse())).toEqual(result);
  });

  it.each([
    { name: "position", patch: { position: 7 } },
    { name: "URL", patch: { url: "https://example.com/other" } },
  ])("rejects newest $name conflicts in both orders", ({ patch }) => {
    const observations = [obs(), obs(patch)];
    expectEmpty(feed(observations), "invalid");
    expectEmpty(feed([...observations].reverse()), "invalid");
  });

  it("allows a newer observation to supersede older conflicts", () => {
    const observations = [
      obs(),
      obs({ position: 7 }),
      obs({
        position: 2,
        checked_at: "2026-09-04T05:00:00Z",
      }),
    ];
    expect(rows(observations).rows[0].position).toBe(2);
    expect(rows([...observations].reverse())).toEqual(rows(observations));
  });

  it.each([
    { name: "undefined", payload: undefined },
    { name: "null", payload: null },
    { name: "empty observations", payload: feed([]) },
  ])("reports missing for $name", ({ payload }) =>
    expectEmpty(payload, "missing"),
  );

  it.each([
    { name: "empty keyword", patch: { keyword: "" } },
    { name: "blank keyword", patch: { keyword: "   " } },
    { name: "long keyword", patch: { keyword: "k".repeat(501) } },
    { name: "empty country", patch: { country: "" } },
    { name: "long country", patch: { country: "c".repeat(81) } },
    { name: "zero position", patch: { position: 0 } },
    { name: "fractional position", patch: { position: 1.5 } },
    { name: "large position", patch: { position: 10001 } },
    { name: "string position", patch: { position: "3" } },
    {
      name: "URL credentials",
      patch: { url: "https://user:pass@example.com/a" },
    },
    { name: "relative URL", patch: { url: "/relative" } },
    { name: "malformed HTTP URL", patch: { url: "https:example.com" } },
    { name: "non-HTTP URL", patch: { url: "ftp://example.com/a" } },
    { name: "missing timezone", patch: { checked_at: "2026-09-03T09:00:00" } },
    { name: "invalid timestamp", patch: { checked_at: "yesterday" } },
    { name: "missing timestamp", patch: { checked_at: undefined } },
    {
      name: "future timestamp",
      patch: { checked_at: "2026-09-04T12:00:00.001Z" },
    },
  ])("rejects the entire feed for $name", ({ patch }) => {
    expectEmpty(
      feed([obs(), obs({ keyword: "green widgets", ...patch })]),
      "invalid",
    );
  });

  it("keeps distinct keyword-country pairs when either contains a delimiter", () => {
    const result = rows([
      obs({ keyword: "a|b", country: "c" }),
      obs({ keyword: "a", country: "b|c" }),
    ]);
    expect(result.rows).toHaveLength(2);
  });

  it("rejects an unexpected source", () => {
    expectEmpty(feed([obs()], { source: "other-collector" }), "invalid");
  });

  it("rejects an invalid supplied clock even for missing data", () => {
    expectEmpty(undefined, "invalid", new Date("not a date"));
  });

  it.each([
    { checkedAt: "2026-09-02T12:00:00.000Z", stale: false },
    { checkedAt: "2026-09-02T11:59:59.999Z", stale: true },
  ])("uses the 48-hour boundary for $checkedAt", ({ checkedAt, stale }) => {
    expect(rows([obs({ checked_at: checkedAt })])).toMatchObject({
      status: "available",
      updatedAt: checkedAt,
      stale,
    });
  });

  it("keeps null positions without inventing search depth or ranking meaning", () => {
    const result = rows([obs({ position: null })]);
    expect(result.rows[0]).toMatchObject({
      position: null,
      device: null,
      depth: null,
    });
    expect(result.note).toMatch(/does not mean/i);
    expect(result.note).toMatch(/not full rank coverage/i);
    expect(result.note).not.toMatch(/not found|outside the top/i);
  });

  it("ignores unsupported method, device, depth and success claims", () => {
    const result = parse(
      feed([obs({ device: "mobile", depth: 100, success: true })], {
        method: "native-serp",
        comparisonsSupported: true,
        unknownTopLevel: true,
      }),
    );
    expect(result).toMatchObject({
      method: "unspecified",
      comparisonsSupported: false,
    });
    expect(result.rows[0]).toMatchObject({ device: null, depth: null });
  });

  it("does not mutate the supplied observations", () => {
    const payload = feed([obs({ keyword: "  Blue Widgets  " }), obs()]);
    const before = structuredClone(payload);
    parse(payload);
    expect(payload).toEqual(before);
  });

  it("rejects more than 500 observations", () => {
    expectEmpty(
      feed(
        Array.from({ length: 501 }, (_, i) => obs({ keyword: `term ${i}` })),
      ),
      "invalid",
    );
  });

  it("distinguishes missing and invalid source data", () => {
    expect(parse(undefined).note).toMatch(/no external rank observations/i);
    expect(rows([obs({ position: 0 })]).note).toMatch(/rejected/i);
  });
});
