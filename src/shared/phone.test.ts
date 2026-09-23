import { afterEach, describe, expect, it, vi } from "vitest";
import { formatNanpPhone } from "./phone";

const forbidden = ["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY"];
if (forbidden.some((key) => key in process.env))
  throw new Error("API-key environment refused");
afterEach(() => vi.unstubAllEnvs());

describe("formatNanpPhone", () => {
  it.each([
    "7787767060",
    "17787767060",
    "+17787767060",
    "+1 778 776 7060",
    "1 (778) 776-7060",
    "778.776.7060",
    "778 776 7060",
    "778-776-7060",
    "(778) 776-7060",
    "+1 (778) 776-7060",
  ])("formats one complete phone without shifting digits: %s", (raw) => {
    expect(formatNanpPhone(raw)).toBe("+1 (778) 776-7060");
  });
  it.each(["ext. 123", "ext 123", "x123", "extension 123", "#123"])(
    "preserves the extension: %s",
    (suffix) => {
      expect(formatNanpPhone(`+1 778.776.7060 ${suffix}`)).toBe(
        "+1 (778) 776-7060 ext. 123",
      );
    },
  );
  it.each([
    "+1 (178) 776-7060",
    "+1 (160) 437-7838",
    "778-176-7060",
    "778-776-70600",
    "+44 20 7946 0958",
    "+44 2345 6789",
    "call 778-776-7060",
    "778ABC7767060",
    "778776 / 7060",
    "778-776-7060 / 604-377-8385",
    "7787767060 6043778385",
    "7787767060\n6043778385",
    "7787767060\nx123",
    "7787767060\n#123",
    "776-7060 ext 778",
    "",
    "not a phone",
    "(778 776-7060",
  ])(
    "leaves ambiguous, malformed or international input unchanged: %s",
    (raw) => {
      expect(formatNanpPhone(raw)).toBe(raw);
    },
  );
  it.each(forbidden)("refuses a configured API key: %s", (name) => {
    vi.stubEnv(name, "");
    expect(() => formatNanpPhone("7787767060")).toThrow(
      "API-key environment refused",
    );
  });
});
