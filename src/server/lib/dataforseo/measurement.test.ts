import type {
  AiOptimizationChatGptLlmScraperTaskPostRequestInfo,
  SerpGoogleAiModeTaskPostRequestInfo,
} from "dataforseo-client";
import { beforeEach, expect, it, vi } from "vitest";
import {
  postMeasurementTasks,
  getMeasurementTask,
  type MeasurementPostReceipt,
} from "./measurement";
const mocks = vi.hoisted(() => ({
  postChat:
    vi.fn<
      (
        tasks: AiOptimizationChatGptLlmScraperTaskPostRequestInfo[],
      ) => Promise<unknown>
    >(),
  postMode:
    vi.fn<(tasks: SerpGoogleAiModeTaskPostRequestInfo[]) => Promise<unknown>>(),
  getChat: vi.fn(),
  getMode: vi.fn(),
}));
vi.mock("./core", () => ({
  measurementAiTaskApi: () => ({
    chatGptLlmScraperTaskPost: mocks.postChat,
    chatGptLlmScraperTaskGetAdvanced: mocks.getChat,
  }),
  measurementSerpTaskApi: () => ({
    googleAiModeTaskPost: mocks.postMode,
    googleAiModeTaskGetAdvanced: mocks.getMode,
  }),
}));
const id = "11111111-2222-0066-0000-aaaaaaaaaaaa";
const answerId = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  mocks.postChat.mockResolvedValue({
    status_code: 20000,
    tasks: [{ id, status_code: 20100, cost: 0.0012, data: { tag: answerId } }],
  });
  mocks.postMode.mockResolvedValue({
    status_code: 20000,
    tasks: [{ id, status_code: 20100, cost: 0.0012, data: { tag: answerId } }],
  });
  mocks.getChat.mockResolvedValue({
    status_code: 20000,
    tasks: [
      {
        id,
        status_code: 20000,
        cost: 0,
        result: [{ markdown: "Synthetic answer" }],
      },
    ],
  });
});
it("posts normal priority scraper tasks and accounts only the posted cost", async () => {
  const result = await postMeasurementTasks({
    persistPosted: async () => {},
    engine: "chatgpt",
    locationCode: 2124,
    languageCode: "en",
    tasks: [{ id: answerId, prompt: "Synthetic + question?" }],
  });
  const body: unknown = mocks.postChat.mock.calls[0][0][0].toJSON();
  expect(body).toMatchObject({
    keyword: "Synthetic %2B question?",
    priority: 1,
    force_web_search: true,
    tag: answerId,
    location_code: 2124,
    language_code: "en",
  });
  expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty("postback_url");
  expect(result.data.rawCredits).toBeCloseTo(1.2);
  expect(result.data.credits).toBeCloseTo(1.54);
  expect(result.billing.path.join("/")).toBe(
    "v3/ai_optimization/chat_gpt/llm_scraper/task_post",
  );
});
it("uses queued AI Mode with a separately metered path", async () => {
  const r = await postMeasurementTasks({
    persistPosted: async () => {},
    engine: "ai_mode",
    locationCode: 2124,
    languageCode: "en",
    tasks: [{ id: answerId, prompt: "Synthetic question?" }],
  });
  expect(mocks.postMode.mock.calls[0][0][0].toJSON()).toMatchObject({
    priority: 1,
    tag: answerId,
  });
  expect(r.billing.path.join("/")).toBe("v3/serp/google/ai_mode/task_post");
});
it("never retries an uncertain submission", async () => {
  mocks.postChat.mockRejectedValue(new Error("Synthetic failure"));
  await expect(
    postMeasurementTasks({
      persistPosted: async () => {},
      engine: "chatgpt",
      locationCode: 2124,
      languageCode: "en",
      tasks: [{ id: answerId, prompt: "Synthetic?" }],
    }),
  ).rejects.toThrow();
  expect(mocks.postChat).toHaveBeenCalledTimes(1);
});
it("collects only the requested queued task and rejects a mismatched id", async () => {
  expect(
    (await getMeasurementTask({ engine: "chatgpt", taskId: id })).result,
  ).toHaveLength(1);
  mocks.getChat.mockResolvedValue({
    status_code: 20000,
    tasks: [{ id: "different", status_code: 20000, cost: 0, result: [] }],
  });
  await expect(
    getMeasurementTask({ engine: "chatgpt", taskId: id }),
  ).rejects.toThrow("identity");
});
it("persists a known paid receipt before returning it to the billing wrapper", async () => {
  const persistPosted = vi.fn(async (_receipt: MeasurementPostReceipt) => {
    throw new Error("Synthetic persistence failure");
  });
  await expect(
    postMeasurementTasks({
      engine: "chatgpt",
      locationCode: 2124,
      languageCode: "en",
      tasks: [{ id: answerId, prompt: "Synthetic?" }],
      persistPosted,
    }),
  ).rejects.toMatchObject({ name: "DataforseoChargedTaskError" });
  expect(persistPosted.mock.calls[0][0].tasks[0].id).toBe(id);
  expect(mocks.postChat).toHaveBeenCalledTimes(1);
});

it("refuses an overlong encoded keyword before a paid post", async () => {
  await expect(
    postMeasurementTasks({
      engine: "chatgpt",
      locationCode: 2124,
      languageCode: "en",
      tasks: [{ id: answerId, prompt: "%".repeat(1000) }],
      persistPosted: async () => {},
    }),
  ).rejects.toThrow();
  expect(mocks.postChat).not.toHaveBeenCalled();
});
