import { SAM_BOX_LEASE_SECONDS } from "./samBoxTypes";

export {
  SAM_BOX_COST_PREFIX,
  SAM_BOX_LEASE_SECONDS,
  SAM_BOX_MAX_PROMPT_BYTES,
} from "./samBoxTypes";

const warnedInvalidSamBoxModes = new Set<string>();

export function getSamBoxMode(env: { SAM_LOOP_GROK_BOX?: string }): "on" | "off" {
  const raw = env.SAM_LOOP_GROK_BOX?.trim();
  if (!raw || raw === "off") return "off";
  if (raw === "on") return "on";
  if (!warnedInvalidSamBoxModes.has(raw)) {
    warnedInvalidSamBoxModes.add(raw);
    console.error(
      `Invalid SAM_LOOP_GROK_BOX "${raw}" — falling back to off. Valid values: on, off.`,
    );
  }
  return "off";
}

export function leaseIdFor(runId: string, startedAt: string): string {
  const startedMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startedMs)) throw new Error("Box lease startedAt is invalid.");
  return `${runId}.${startedMs}`;
}

export function leaseExpiresAt(startedAt: string): string {
  return new Date(
    new Date(startedAt).getTime() + SAM_BOX_LEASE_SECONDS * 1000,
  ).toISOString();
}
