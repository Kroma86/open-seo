/**
 * HomeGrown OTTO fix proposals queued by SAM / MCP.
 * Stored in Workers KV. Hermes pulls them into OTTO pending/ — nothing deploys
 * from this layer. Jon's OTTO gate remains the only path to approved/.
 */
import { env } from "cloudflare:workers";

const KEY_PREFIX = "homegrown-otto:proposal:";
const INDEX_KEY = "homegrown-otto:proposal-index";
const MAX_INDEX = 500;

type HomegrownOttoProposal = {
  id: string;
  domain: string;
  projectId: string | null;
  status: "pending" | "pulled" | "rejected";
  proposedAt: string;
  proposedBy: "sam" | "mcp" | "api";
  path: string;
  fixes: Record<string, string>;
  before: Record<string, unknown>;
  humanReview: string[];
  flags: string[];
  rationale: string | null;
  pulledAt: string | null;
  /**
   * Present on records written by the agency API path. Older and
   * MCP-written records do not carry it, so it is optional — the KV
   * store has more than one producer and they do not agree on shape.
   */
  organizationId?: string | null;
};

function kv(): KVNamespace {
  return env.KV;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function proposalKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

async function readIndex(): Promise<string[]> {
  const raw = await kv().get(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

async function writeIndex(ids: string[]): Promise<void> {
  await kv().put(INDEX_KEY, JSON.stringify(ids.slice(0, MAX_INDEX)));
}

export async function enqueueHomegrownOttoProposal(input: {
  domain: string;
  projectId?: string | null;
  path?: string;
  /** Non-string and blank values are dropped. */
  fixes: Record<string, unknown>;
  before?: Record<string, unknown>;
  humanReview?: string[];
  flags?: string[];
  rationale?: string | null;
  proposedBy?: HomegrownOttoProposal["proposedBy"];
}): Promise<HomegrownOttoProposal> {
  const domain = input.domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
  if (!domain) {
    throw new Error("domain_required");
  }
  const fixes = Object.fromEntries(
    Object.entries(input.fixes).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].trim().length > 0,
    ),
  );
  if (Object.keys(fixes).length === 0) {
    throw new Error("fixes_required");
  }

  const proposal: HomegrownOttoProposal = {
    id: crypto.randomUUID(),
    domain,
    projectId: input.projectId ?? null,
    status: "pending",
    proposedAt: new Date().toISOString(),
    proposedBy: input.proposedBy ?? "mcp",
    path: input.path?.trim() || "/",
    fixes,
    before: input.before ?? {},
    humanReview: input.humanReview ?? [],
    flags: [...(input.flags ?? []), "source:openseo_sam"],
    rationale: input.rationale ?? null,
    pulledAt: null,
  };

  await kv().put(proposalKey(proposal.id), JSON.stringify(proposal));
  const index = await readIndex();
  await writeIndex([proposal.id, ...index.filter((id) => id !== proposal.id)]);
  return proposal;
}

/**
 * Project a stored record onto the declared shape.
 *
 * These rows are JSON in KV written by several producers over time, so a row
 * can carry keys this module never declared. That is not a theory: on
 * 2026-09-18 four of eighteen pending rows carried `organizationId`, and
 * because the MCP tool publishes its output schema with
 * `additionalProperties: false`, every `list_homegrown_otto_proposals` call
 * failed client-side validation. Returning the parsed row unchanged makes the
 * published contract only as stable as the oldest writer.
 *
 * Read normalizes; the pull path below still round-trips the whole record, so
 * nothing is dropped from storage.
 */
const PROPOSAL_STATUSES = ["pending", "pulled", "rejected"] as const;
const PROPOSERS = ["sam", "mcp", "api"] as const;

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return values.some((v) => v === value);
}

function stringOr<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

// KV rows have several producers, so every field is checked rather than cast.
// A missing or wrong-typed field gets the same default a missing one always
// did; the read side must never emit a value the output schema rejects.
function toProposal(raw: unknown): HomegrownOttoProposal | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.domain !== "string") return null;
  const organizationId = raw.organizationId;
  return {
    id: raw.id,
    domain: raw.domain,
    projectId: stringOr(raw.projectId, null),
    status: oneOf(PROPOSAL_STATUSES, raw.status) ? raw.status : "pending",
    proposedAt: stringOr(raw.proposedAt, ""),
    proposedBy: oneOf(PROPOSERS, raw.proposedBy) ? raw.proposedBy : "api",
    path: stringOr(raw.path, "/"),
    fixes: isRecord(raw.fixes)
      ? Object.fromEntries(
          Object.entries(raw.fixes).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {},
    before: isRecord(raw.before) ? raw.before : {},
    humanReview: stringList(raw.humanReview),
    flags: stringList(raw.flags),
    rationale: stringOr(raw.rationale, null),
    pulledAt: stringOr(raw.pulledAt, null),
    ...(organizationId === undefined
      ? {}
      : { organizationId: stringOr(organizationId, null) }),
  };
}

export async function listHomegrownOttoProposals(input?: {
  /** Unvalidated filter: an unknown status matches no stored proposal. */
  status?: string;
  domain?: string;
  limit?: number;
}): Promise<HomegrownOttoProposal[]> {
  const limit = Math.min(Math.max(input?.limit ?? 50, 1), 200);
  const index = await readIndex();
  const out: HomegrownOttoProposal[] = [];
  for (const id of index) {
    if (out.length >= limit) break;
    const raw = await kv().get(proposalKey(id));
    if (!raw) continue;
    try {
      const proposal = toProposal(JSON.parse(raw));
      if (!proposal) continue;
      if (input?.status && proposal.status !== input.status) continue;
      if (
        input?.domain &&
        proposal.domain !==
          input.domain
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/^www\./, "")
            .split("/")[0]
      ) {
        continue;
      }
      out.push(proposal);
    } catch {
      // skip corrupt rows
    }
  }
  return out;
}

export async function markHomegrownOttoProposalsPulled(
  ids: string[],
): Promise<number> {
  let marked = 0;
  const now = new Date().toISOString();
  for (const id of ids) {
    const raw = await kv().get(proposalKey(id));
    if (!raw) continue;
    try {
      const proposal: unknown = JSON.parse(raw);
      if (!isRecord(proposal) || proposal.status !== "pending") continue;
      proposal.status = "pulled";
      proposal.pulledAt = now;
      await kv().put(proposalKey(id), JSON.stringify(proposal));
      marked += 1;
    } catch {
      // skip
    }
  }
  return marked;
}
