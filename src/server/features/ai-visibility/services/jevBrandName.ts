import { getRequiredEnvValue } from "@/server/lib/runtime-env";
import {
  JEV_DECISIONS_URL,
  type JevDecisionBody,
  type JevNamedAnswer,
} from "@/server/features/ai-visibility/services/brandNameDecision";

/**
 * One Jev yes/no call. OpenSEO is a Worker, so this uses the Worker's
 * existing OpenRouter key. It does not shell out to the jev command.
 * The key is never logged.
 */
export async function askJevNamed(
  body: JevDecisionBody,
): Promise<JevNamedAnswer> {
  const apiKey = await getRequiredEnvValue("OPENROUTER_API_KEY");
  const response = await fetch(JEV_DECISIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`jev_http_${response.status}`);
  }
  const payload: unknown = await response.json();
  const record = isRecord(payload) ? payload : {};
  const answers = isRecord(record.answers) ? record.answers : {};
  const named = isRecord(answers.named) ? answers.named : {};
  const usage = isRecord(record.usage) ? record.usage : {};
  const p = named.noul;
  if (typeof p !== "number" || !Number.isFinite(p)) {
    throw new Error("jev_missing_probability");
  }
  const costUsd =
    typeof usage.cost === "number" && usage.cost >= 0 ? usage.cost : 0;
  return { p, costUsd };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
