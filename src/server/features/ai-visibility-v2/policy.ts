import { SEO_DATA_COST_MARKUP, applyBillingMarkupUsd } from "@/shared/billing";
import { z } from "zod";

// Activation requires a separately reviewed enrollment with current owner evidence.
export const MEASUREMENT_V2 = {
  enabled: false,
  dryRun: true,
  spendBoundVerified: false,
} as const;
export const PILOT_PROJECTS: Readonly<Record<string, string>> = {
  "66deab65-740d-4144-959e-24f24420e428": "twa.studio",
  "cd5fb517-326b-4ee8-b77e-d98ee2c68012": "homecaresolutions.ca",
  "3c447efd-bfb4-4121-9ad2-b70f5304c2ff": "sweetbeesbaskets.ca",
  "a746b566-c154-48d8-bf8f-31e8066c352d": "ecliptechplumbing.ca",
  "22ec3459-0f5c-4149-a479-6d13a85b5b2a": "newbeginningscounsellingservice.com",
};
export const CAPS = {
  answersPerRun: 60,
  creditsPerClientWeek: 108,
  answersPerWeek: 300,
  creditsPerWeek: 540,
  rawCreditsPerAnswer: 1.2,
  creditsPerAnswer: 1.2 * SEO_DATA_COST_MARKUP,
} as const;
export const enrollmentSchema = z.object({
  projectId: z.string().uuid(),
  configId: z.string().uuid(),
  domain: z.string().min(1),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  eligibilityEvidence: z.string().min(1),
  eligibilityHash: z.string().regex(/^[a-f0-9]{64}$/),
  verifiedAt: z.iso.datetime(),
  startsAt: z.iso.datetime(),
  dryRunAt: z.iso.datetime().nullable(),
  dryRunHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type Enrollment = z.infer<typeof enrollmentSchema>;
export function validateEnrollments(
  raw: unknown,
  now: Date,
  live: boolean,
): Enrollment[] {
  const rows = z.array(enrollmentSchema).length(5).parse(raw);
  if (
    new Set(rows.map((r) => r.projectId)).size !== 5 ||
    new Set(rows.map((r) => r.domain)).size !== 5
  )
    throw new Error("Exactly five distinct enrolled projects required");
  for (const r of rows) {
    if (PILOT_PROJECTS[r.projectId] !== r.domain)
      throw new Error("Project outside candidate allowlist");
    const start = Date.parse(r.startsAt);
    if (
      !Number.isFinite(now.getTime()) ||
      now.getTime() < start ||
      now.getTime() >= start + 7 * 86400000 ||
      Date.parse(r.verifiedAt) > start ||
      start - Date.parse(r.verifiedAt) > 86400000
    )
      throw new Error("Enrollment evidence missing, stale or expired");
    if (r.domain.replace(/^www\./, "").toLowerCase() === "vanyalaporte.com")
      throw new Error("Excluded project");
    if (
      live &&
      (!r.dryRunAt ||
        Date.parse(r.dryRunAt) < start ||
        Date.parse(r.dryRunAt) > now.getTime())
    )
      throw new Error("Dry run required before posting");
  }
  return rows;
}
export function estimateAnswers(questionCount: number) {
  if (
    !Number.isInteger(questionCount) ||
    questionCount < 1 ||
    questionCount > 15
  )
    throw new Error("Stored question set must contain 1 to 15 questions");
  const answers = questionCount * 4;
  const rawUsdPerAnswer = CAPS.rawCreditsPerAnswer / 1000;
  const credits =
    Math.round(
      (applyBillingMarkupUsd(questionCount * 3 * rawUsdPerAnswer) +
        applyBillingMarkupUsd(questionCount * rawUsdPerAnswer)) *
        100000,
    ) / 100;
  if (answers > CAPS.answersPerRun || credits > CAPS.creditsPerClientWeek)
    throw new Error("Run estimate exceeds caps");
  return { answers, rawCredits: answers * CAPS.rawCreditsPerAnswer, credits };
}
export function withinWeeklyCaps(answers: number, credits: number) {
  return (
    Number.isInteger(answers) &&
    answers >= 0 &&
    Number.isFinite(credits) &&
    credits >= 0 &&
    answers <= CAPS.answersPerWeek &&
    credits <= CAPS.creditsPerWeek
  );
}
export function weekStart(now: Date): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export async function sha256(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
