import { describe, expect, it } from "vitest";
import {
  formatMentionsDisplay,
  sumMentionsForPlatforms,
} from "@/shared/ai-visibility-mentions";
import type { BrandLookupResult } from "@/types/schemas/ai-search";

function brandLookup(
  perPlatform: BrandLookupResult["perPlatform"],
): BrandLookupResult {
  return {
    query: "Acme",
    detectedTargetType: "domain",
    resolvedTarget: "acme.com",
    scope: null,
    aggregatesAreDomainLevel: true,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    hasData: true,
    totalMentions: null,
    totalAiSearchVolume: null,
    perPlatform,
    topPages: [],
    topQueries: [],
    monthlyVolume: [],
    shareOfVoice: null,
  };
}

describe("sumMentionsForPlatforms", () => {
  it("flags partial totals when any selected platform is unknown", () => {
    const result = sumMentionsForPlatforms(
      brandLookup([
        {
          platform: "google",
          status: "success",
          mentions: 10,
          aiSearchVolume: null,
        },
        {
          platform: "chat_gpt",
          status: "success",
          mentions: null,
          aiSearchVolume: null,
        },
      ]),
      ["google", "chat_gpt"],
    );
    expect(result).toEqual({ total: 10, partialMentions: true });
  });

  it("returns null when every selected platform is unknown", () => {
    const result = sumMentionsForPlatforms(
      brandLookup([
        {
          platform: "google",
          status: "success",
          mentions: null,
          aiSearchVolume: null,
        },
        {
          platform: "chat_gpt",
          status: "success",
          mentions: null,
          aiSearchVolume: null,
        },
      ]),
      ["google", "chat_gpt"],
    );
    expect(result).toEqual({ total: null, partialMentions: false });
  });
});

describe("formatMentionsDisplay", () => {
  it("renders partial sums honestly", () => {
    expect(formatMentionsDisplay(12, true)).toBe("≥ 12 (partial)");
    expect(formatMentionsDisplay(12, false)).toBe("12");
    expect(formatMentionsDisplay(null, false)).toBe("not measured");
  });
});
