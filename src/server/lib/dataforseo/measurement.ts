import {
  applyBillingMarkupUsd,
  AUTUMN_SEO_DATA_CREDITS_PER_USD,
} from "@/shared/billing";
import { z } from "zod";
import {
  AiOptimizationChatGptLlmScraperTaskPostRequestInfo,
  SerpGoogleAiModeTaskPostRequestInfo,
} from "dataforseo-client";
import { measurementAiTaskApi, measurementSerpTaskApi } from "./core";
import { DataforseoChargedTaskError } from "./envelope";
import type { Engine } from "@/server/features/ai-visibility-v2/match";

const taskSchema = z.object({
  id: z.string().nullable().optional(),
  status_code: z.number().int(),
  cost: z.number().nonnegative(),
  data: z.object({ tag: z.string().optional() }).nullable().optional(),
  result: z.array(z.unknown()).nullable().optional(),
});
const envelopeSchema = z.object({
  status_code: z.literal(20000),
  tasks: z.array(taskSchema),
});
const inputSchema = z.object({
  engine: z.enum(["chatgpt", "ai_mode"]),
  locationCode: z.number().int().positive(),
  languageCode: z.string().min(2),
  tasks: z
    .array(
      z.object({ id: z.string().uuid(), prompt: z.string().min(1).max(2000) }),
    )
    .min(1)
    .max(100),
});
export type MeasurementPostReceipt = {
  tasks: z.infer<typeof taskSchema>[];
  rawCredits: number;
  credits: number;
};
export async function postMeasurementTasks(
  input: z.infer<typeof inputSchema> & {
    persistPosted: (receipt: MeasurementPostReceipt) => Promise<void>;
  },
) {
  const value = inputSchema.parse(input);
  if (typeof input.persistPosted !== "function")
    throw new Error("Durable receipt writer required before task_post");
  const fields = value.tasks.map((t) => ({
    keyword: z
      .string()
      .max(2000)
      .parse(t.prompt.replace(/%/g, "%25").replace(/\+/g, "%2B")),
    tag: t.id,
    location_code: value.locationCode,
    language_code: value.languageCode,
    priority: 1,
  }));
  const response =
    value.engine === "chatgpt"
      ? await measurementAiTaskApi().chatGptLlmScraperTaskPost(
          fields.map(
            (f) =>
              new AiOptimizationChatGptLlmScraperTaskPostRequestInfo({
                ...f,
                force_web_search: true,
              }),
          ),
        )
      : await measurementSerpTaskApi().googleAiModeTaskPost(
          fields.map((f) => new SerpGoogleAiModeTaskPostRequestInfo(f)),
        );
  const parsed = envelopeSchema.parse(response);
  const costUsd = parsed.tasks.reduce((s, t) => s + t.cost, 0);
  const data = {
    tasks: parsed.tasks,
    rawCredits: costUsd * AUTUMN_SEO_DATA_CREDITS_PER_USD,
    credits:
      Math.round(
        applyBillingMarkupUsd(costUsd) * AUTUMN_SEO_DATA_CREDITS_PER_USD * 100,
      ) / 100,
  };
  console.info("[measurement-v2] posted cost", {
    rawCredits: data.rawCredits,
    billedCredits: data.credits,
  });
  const billing = {
    path: [
      "v3",
      ...(value.engine === "chatgpt"
        ? ["ai_optimization", "chat_gpt", "llm_scraper"]
        : ["serp", "google", "ai_mode"]),
      "task_post",
    ],
    costUsd,
  };
  try {
    await input.persistPosted(data);
  } catch {
    throw new DataforseoChargedTaskError(
      "Measurement receipt or accounting could not finish after task_post; do not replay",
      billing,
    );
  }
  return { data, billing };
}
export async function getMeasurementTask(input: {
  engine: Engine;
  taskId: string;
}) {
  z.string()
    .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)
    .parse(input.taskId);
  const response =
    input.engine === "chatgpt"
      ? await measurementAiTaskApi().chatGptLlmScraperTaskGetAdvanced(
          input.taskId,
        )
      : await measurementSerpTaskApi().googleAiModeTaskGetAdvanced(
          input.taskId,
        );
  const parsed = envelopeSchema
    .refine((r) => r.tasks.length === 1 && r.tasks[0].id === input.taskId, {
      message: "Measurement task identity mismatch",
    })
    .parse(response);
  return parsed.tasks[0];
}
