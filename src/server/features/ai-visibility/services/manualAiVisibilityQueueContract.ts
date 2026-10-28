import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";

export const MANUAL_AI_QUEUE_KIND = "manual_ai_visibility_v1";
export const MANUAL_AI_QUEUE_PREFIX = `{"queue":"${MANUAL_AI_QUEUE_KIND}",`;

// Immutable request context, not a substitute for live project/config checks.
export const manualAiQueueEnvelopeSchema = z
  .object({
    queue: z.literal(MANUAL_AI_QUEUE_KIND),
    billingCustomer: z
      .object({
        userId: z.string().min(1),
        userEmail: z.string().email(),
        organizationId: z.string().min(1),
        projectId: z.string().min(1),
      })
      .strict(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function manualAiQueueEnvelope(
  billingCustomer: BillingCustomerContext,
  projectId: string,
  fingerprint: string,
) {
  return JSON.stringify(
    manualAiQueueEnvelopeSchema.parse({
      queue: MANUAL_AI_QUEUE_KIND,
      billingCustomer: {
        userId: billingCustomer.userId,
        userEmail: billingCustomer.userEmail,
        organizationId: billingCustomer.organizationId,
        projectId,
      },
      fingerprint,
    }),
  );
}

export async function aiVisibilityRequestFingerprint(input: {
  config: {
    id: string;
    projectId: string;
    brand: string;
    competitors: string;
    platforms: string;
    promptSetVersion: number;
    scheduleInterval: string;
    isActive: boolean;
  };
  project: {
    id?: string;
    domain?: string | null;
    locationCode: number;
    languageCode: string;
  };
  prompts: Array<{ id: string; prompt: string }>;
}) {
  const { config, project } = input;
  const snapshot = {
    configId: config.id,
    projectId: config.projectId,
    brand: config.brand,
    competitors: config.competitors,
    platforms: config.platforms,
    promptSetVersion: config.promptSetVersion,
    scheduleInterval: config.scheduleInterval,
    isActive: config.isActive,
    domain: project.domain ?? null,
    locationCode: project.locationCode,
    languageCode: project.languageCode,
    prompts: input.prompts
      .map(({ id, prompt }) => ({ id, prompt }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(snapshot)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
