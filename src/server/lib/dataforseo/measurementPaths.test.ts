import { expect, it, vi } from "vitest";
import { assertMeasurementRequestPath } from "./measurementPaths";
import { measurementAiTaskApi, measurementSerpTaskApi } from "./core";
vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(() => {
    throw new Error("Credentials must not be read");
  }),
}));
it("rejects every live request path before credential lookup or fetch", () => {
  for (const path of [
    "ai_optimization/chat_gpt/llm_scraper/live/advanced",
    "ai_optimization/chat_gpt/llm_responses/live",
    "serp/google/ai_mode/live/advanced",
    "serp/google/ai_mode/task_post/live",
    "serp/google/ai_mode/li%76e/advanced",
  ])
    expect(() =>
      assertMeasurementRequestPath(`https://api.dataforseo.com/v3/${path}`),
    ).toThrow("queued");
  expect(() => measurementAiTaskApi().chatGptLlmResponsesLive([])).toThrow(
    "queued",
  );
  expect(() => measurementSerpTaskApi().googleAiModeLiveAdvanced([])).toThrow(
    "queued",
  );
});
it("accepts only the two documented queued post/get paths", () => {
  for (const engine of [
    "ai_optimization/chat_gpt/llm_scraper",
    "serp/google/ai_mode",
  ])
    for (const suffix of [
      "task_post",
      "task_get/advanced/00000000-0000-4000-8000-000000000001",
    ])
      expect(() =>
        assertMeasurementRequestPath(
          `https://api.dataforseo.com/v3/${engine}/${suffix}`,
        ),
      ).not.toThrow();
});
