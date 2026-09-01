import { z } from "zod";
import type { InferSelectModel } from "drizzle-orm";
import { samLoops, samLoopRuns } from "@/db/app.schema";

export type SamLoop = InferSelectModel<typeof samLoops>;
export type SamLoopRun = InferSelectModel<typeof samLoopRuns>;

export type SamLoopTriggerResult =
  | { ok: true; runId: string }
  | {
      ok: false;
      reason: "already_running" | "disabled" | "not_found" | "daily_cap";
      blockingRunId?: string | null;
    };

const sourceTypeEnum = z.enum(samLoops.sourceType.enumValues);
const cadenceEnum = z.enum(samLoops.cadence.enumValues);

export const listSamLoopsSchema = z.object({
  projectId: z.string().uuid(),
});

export const createSamLoopSchema = z
  .object({
    projectId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    sourceType: sourceTypeEnum,
    skillName: z.string().trim().min(1).max(120).optional(),
    customPrompt: z.string().trim().min(1).max(20_000).optional(),
    cadence: cadenceEnum.default("weekly"),
    isEnabled: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.sourceType === "skill" && !value.skillName) {
      ctx.addIssue({
        code: "custom",
        message: "skillName is required when sourceType is skill",
        path: ["skillName"],
      });
    }
    if (value.sourceType === "custom" && !value.customPrompt) {
      ctx.addIssue({
        code: "custom",
        message: "customPrompt is required when sourceType is custom",
        path: ["customPrompt"],
      });
    }
  });

export const updateSamLoopSchema = z.object({
  projectId: z.string().uuid(),
  loopId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  isEnabled: z.boolean().optional(),
  cadence: cadenceEnum.optional(),
  customPrompt: z.string().trim().min(1).max(20_000).optional(),
});

export const getSamLoopRunsSchema = z.object({
  projectId: z.string().uuid(),
  loopId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const triggerSamLoopSchema = z.object({
  projectId: z.string().uuid(),
  loopId: z.string().uuid(),
});

export const getSamLoopRunSchema = z.object({
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
});

export type ContentVelocityMonthCounts = Record<string, number>;

export type ContentVelocityLoop = {
  loopId: string;
  loopName: string;
  cadence: SamLoop["cadence"];
  isEnabled: boolean;
  expectedPerMonth: number;
  drafted: ContentVelocityMonthCounts;
  completedWithoutDraft: ContentVelocityMonthCounts;
};

export type ContentVelocity = {
  months: string[];
  loops: ContentVelocityLoop[];
};
