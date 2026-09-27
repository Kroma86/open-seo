import { describe, expect, it } from "vitest";
import {
  countRealMentions,
  formatRealMentions,
  JEV_ABOUT_THIS_BUSINESS_QUESTION,
  JEV_RUN_CAP_USD,
  parseStoredRealMentions,
  sumRealMentions,
} from "./real-mentions";

describe("real mentions", () => {
  it("counts a source only when p is at least 0.5", () => {
    expect(countRealMentions([0.91, 0.8, 0.5, 0.49, 0.02])).toBe(3);
    expect(countRealMentions([])).toBe(0);
    expect(countRealMentions([0.2, null])).toBeNull();
    expect(countRealMentions([1.2])).toBeNull();
  });

  it("sums the estate only when every run was graded", () => {
    expect(sumRealMentions([2, 1, 0, 0])).toBe(3);
    expect(sumRealMentions([2, null])).toBeNull();
  });

  it("counts the stored 23 Sep probabilities at the 0.5 line", () => {
    // Stored Jev scores from the 23 Sep cited sources. The SSOCC homepage
    // was 0.43, so it is the unsure item and does not count. The SSOCC
    // sandpiper page (0.84) and the Cinnamon sex-therapy page (0.77) do.
    expect(countRealMentions([0.43, 0.84])).toBe(1);
    expect(countRealMentions([0.77])).toBe(1);
    expect(sumRealMentions([1, 1, 0])).toBe(2);
  });

  it("reads either stored field and treats an old run as not measured", () => {
    expect(
      parseStoredRealMentions(
        JSON.stringify({ brandLookup: { real_mentions: 3 } }),
      ),
    ).toBe(3);
    expect(
      parseStoredRealMentions(
        JSON.stringify({ brandLookup: { totalMentions: 11880 } }),
      ),
    ).toBeNull();
    expect(parseStoredRealMentions("not json")).toBeNull();
    expect(formatRealMentions(null)).toBe("not measured");
    expect(formatRealMentions(3)).toBe("3");
  });

  it("keeps the question and the one-cent cap stable", () => {
    expect(JEV_RUN_CAP_USD).toBe(0.01);
    expect(JEV_ABOUT_THIS_BUSINESS_QUESTION).toContain("business.website");
    expect(JEV_ABOUT_THIS_BUSINESS_QUESTION).toContain("Answer no");
  });
});
