import { describe, expect, it } from "vitest";
import { selfHostBaseUrl } from "./selfHostBaseUrl";

describe("selfHostBaseUrl", () => {
  it("uses BETTER_AUTH_URL origin when set", () => {
    expect(
      selfHostBaseUrl({ BETTER_AUTH_URL: "https://seo.niceseo.ai/" }),
    ).toBe("https://seo.niceseo.ai");
  });

  it("falls back to hosted app origin when unset or invalid", () => {
    expect(selfHostBaseUrl({})).toBe("https://app.openseo.so");
    expect(selfHostBaseUrl({ BETTER_AUTH_URL: "   " })).toBe(
      "https://app.openseo.so",
    );
    expect(selfHostBaseUrl({ BETTER_AUTH_URL: "not a url" })).toBe(
      "https://app.openseo.so",
    );
  });
});
