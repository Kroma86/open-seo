import { env } from "cloudflare:workers";
import { z } from "zod";
import { SAM_LOOP_STEP_CAP } from "@/shared/sam-loops";
import type { SubscriptionSteps } from "./subscriptionContract";
const RECEIPT_MAX_BYTES = 700_000;

export class SubscriptionLoopError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

type Receipt = {
  runId: string;
  loopId: string;
  projectId: string;
  model: string;
  startedAt: string;
  scheduledFor: string;
  houseOnly?: true;
  steps: SubscriptionSteps;
};
const receiptSchema = z
  .object({
    runId: z.string().uuid(),
    loopId: z.string().uuid(),
    projectId: z.string().uuid(),
    model: z.enum(["grok-4.7", "grok-4.7-build-fast"]),
    startedAt: z.iso.datetime(),
    scheduledFor: z.iso.datetime(),
    houseOnly: z.literal(true).optional(),
    steps: z
      .array(
        z
          .object({
            toolCalls: z
              .array(
                z
                  .object({
                    toolName: z.string(),
                    input: z.record(z.string(), z.unknown()),
                  })
                  .strict(),
              )
              .length(1),
            toolResults: z
              .array(
                z
                  .object({ toolName: z.string(), output: z.unknown() })
                  .strict(),
              )
              .length(1),
          })
          .strict(),
      )
      .max(SAM_LOOP_STEP_CAP),
  })
  .strict();

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
async function signingKey() {
  const secret = (env as { AGENCY_SCORE_EXPORT_TOKEN?: string })
    .AGENCY_SCORE_EXPORT_TOKEN;
  if (!secret) throw new SubscriptionLoopError("subscription_disabled", 503);
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signReceipt(receipt: Receipt): Promise<string> {
  const serialized = wireJson(receipt);
  receiptSchema.parse(JSON.parse(serialized));
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.length > RECEIPT_MAX_BYTES)
    throw new SubscriptionLoopError("evidence_limit");
  const signature = await crypto.subtle.sign("HMAC", await signingKey(), bytes);
  return `${encode(bytes)}.${encode(new Uint8Array(signature))}`;
}
export async function readReceipt(token: string): Promise<Receipt> {
  const key = await signingKey();
  try {
    const parts = token.split(".");
    if (parts.length !== 2) throw new Error();
    const bytes = decode(parts[0]);
    if (
      bytes.length > RECEIPT_MAX_BYTES ||
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        new Uint8Array(decode(parts[1])).buffer,
        new Uint8Array(bytes).buffer,
      ))
    )
      throw new Error();
    return receiptSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new SubscriptionLoopError("invalid_receipt", 400);
  }
}
export function wireJson(value: unknown): string {
  const ancestors = new Set<object>();
  const check = (item: unknown, depth: number): void => {
    if (depth > 64) throw new SubscriptionLoopError("invalid_tool_evidence");
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || ancestors.has(item))
      throw new SubscriptionLoopError("invalid_tool_evidence");
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        Object.getOwnPropertySymbols(item).length
      )
        throw new SubscriptionLoopError("invalid_tool_evidence");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.keys(descriptors).length !== item.length + 1)
        throw new SubscriptionLoopError("invalid_tool_evidence");
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || descriptor.get || descriptor.set)
          throw new SubscriptionLoopError("invalid_tool_evidence");
        check(descriptor.value, depth + 1);
      }
    } else {
      const prototype: unknown = Object.getPrototypeOf(item);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        Object.getOwnPropertySymbols(item).length
      )
        throw new SubscriptionLoopError("invalid_tool_evidence");
      for (const descriptor of Object.values(
        Object.getOwnPropertyDescriptors(item),
      )) {
        if (!descriptor.enumerable || descriptor.get || descriptor.set)
          throw new SubscriptionLoopError("invalid_tool_evidence");
        check(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  check(value, 0);
  return JSON.stringify(value);
}
export async function receiptState(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return `subscription:${encode(new Uint8Array(digest))}`;
}
