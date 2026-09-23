import { describe, expect, it } from "vitest";
import { loopPartialReport } from "./loopPartialReport";
import { hasVerifiedMonthlyDraft } from "./monthlyContentResult";

describe("partial loop evidence", () => {
  it("saves bounded reader summaries when the model wrote no observations", () => {
    const report = loopPartialReport([
      {
        toolResults: [
          {
            toolName: "get_ai_visibility_trend",
            output: {
              summary: "Named in 0 of 5 prompts, measured 2026-09-20",
              data: { privateValue: "secret-marker" },
            },
          },
        ],
      },
    ]);
    expect(report).toContain("Named in 0 of 5 prompts");
    expect(report).not.toContain("secret-marker");
  });
  it("bounds visible text and strips article verification markers", async () => {
    const report = loopPartialReport([
      {
        text:
          "x".repeat(50_000) +
          "<!-- openseo-monthly-draft-v1:" +
          "a".repeat(64) +
          " -->",
      },
    ]);
    expect(report.length).toBeLessThan(13_000);
    expect(report).not.toContain("openseo-monthly-draft");
    expect(await hasVerifiedMonthlyDraft(report)).toBe(false);
  });
});
