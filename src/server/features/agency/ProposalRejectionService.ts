import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  ProposalRejectionsRepository,
  type ProposalRejection,
} from "./repositories/ProposalRejectionsRepository";

export class ProposalRejectionError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

const rejectionInput = z
  .object({
    id: z.string().uuid(),
    domain: z.string().min(1).max(253),
    path: z.string().startsWith("/").max(2048),
    expectedPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: z.string().uuid(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
const lookupInput = z.array(z.string().uuid()).min(1).max(75);

// JSON values only. Sort recursively, preserving arrays and every unknown key.
// Only the two top-level lifecycle fields may change in existing KV writers.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function proposalPayloadHash(
  record: Record<string, unknown>,
): Promise<string> {
  const payload = Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => key !== "status" && key !== "pulledAt",
    ),
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(payload)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function getProposalRejections(
  ids: unknown,
): Promise<ProposalRejection[]> {
  const parsed = lookupInput.safeParse(ids);
  if (!parsed.success)
    throw new ProposalRejectionError("invalid_rejection_ids", 400);
  return ProposalRejectionsRepository.findByIds([...new Set(parsed.data)]);
}

export async function rejectHomegrownOttoProposal(
  input: unknown,
): Promise<ProposalRejection> {
  const parsed = rejectionInput.safeParse(input);
  if (!parsed.success)
    throw new ProposalRejectionError("invalid_rejection", 400);
  const request = parsed.data;
  const raw = await env.KV.get(`homegrown-otto:proposal:${request.id}`);
  if (!raw) throw new ProposalRejectionError("proposal_not_found", 404);
  let record: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    record = value as Record<string, unknown>;
  } catch {
    throw new ProposalRejectionError("invalid_stored_proposal", 409);
  }
  if (
    record.id !== request.id ||
    record.domain !== request.domain ||
    (record.path ?? "/") !== request.path ||
    (record.status !== "pending" && record.status !== "pulled") ||
    (record.organizationId != null &&
      typeof record.organizationId !== "string") ||
    (record.pulledAt != null && typeof record.pulledAt !== "string")
  ) {
    throw new ProposalRejectionError(
      "proposal_identity_or_state_mismatch",
      409,
    );
  }
  const payloadHash = await proposalPayloadHash(record);
  if (payloadHash !== request.expectedPayloadHash)
    throw new ProposalRejectionError("proposal_payload_mismatch", 409);
  const result = await ProposalRejectionsRepository.insertIfAbsent({
    proposalId: request.id,
    payloadHash,
    domain: request.domain,
    path: request.path,
    organizationId:
      (record.organizationId as string | null | undefined) ?? null,
    requestId: request.requestId,
    reason: request.reason,
    rejectedAt: new Date().toISOString(),
    priorStatus: record.status,
    priorPulledAt: (record.pulledAt as string | null | undefined) ?? null,
  });
  // A competing action cannot silently inherit this request's receipt.
  if (
    result.payloadHash !== payloadHash ||
    result.domain !== request.domain ||
    result.path !== request.path ||
    result.requestId !== request.requestId ||
    result.reason !== request.reason
  ) {
    throw new ProposalRejectionError(
      "proposal_already_rejected_by_different_action",
      409,
    );
  }
  return result;
}
