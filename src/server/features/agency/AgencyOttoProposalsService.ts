/**
 * HomeGrown OTTO fix proposals queued by SAM / MCP.
 * Stored in Workers KV. Hermes pulls them into OTTO pending/ — nothing deploys
 * from this layer. Jon's OTTO gate remains the only path to approved/.
 */
import { env } from "cloudflare:workers";

const KEY_PREFIX = "homegrown-otto:proposal:";
const INDEX_KEY = "homegrown-otto:proposal-index";
const MAX_INDEX = 500;
const READ_BATCH = 25;

export type HomegrownOttoProposal = {
  id: string;
  domain: string;
  // Owner of the proposal. Null only on rows written before 2026-09-09 or by
  // the Hermes bearer route when the domain did not resolve to one project.
  organizationId: string | null;
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
};

function kv(): KVNamespace {
  return env.KV;
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
  // Owner. Required: pass `null` only on the explicit unowned path (Hermes
  // bearer route, domain with no project), never by omission.
  organizationId: string | null;
  projectId?: string | null;
  path?: string;
  fixes: Record<string, string>;
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
      ([, value]) => typeof value === "string" && value.trim().length > 0,
    ),
  );
  if (Object.keys(fixes).length === 0) {
    throw new Error("fixes_required");
  }

  const proposal: HomegrownOttoProposal = {
    id: crypto.randomUUID(),
    domain,
    organizationId: input.organizationId,
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
 * can carry keys this module never declared (2026-09-18: rows with an extra key
 * made every `list_homegrown_otto_proposals` call fail output validation,
 * because the tool publishes `additionalProperties: false`). Read normalizes;
 * the pull path below still round-trips the whole record, so nothing is
 * dropped from storage.
 */
function toProposal(raw: unknown): HomegrownOttoProposal | null {
  const r = raw as Partial<HomegrownOttoProposal> | null;
  if (!r || typeof r.id !== "string" || typeof r.domain !== "string")
    return null;
  return {
    id: r.id,
    domain: r.domain,
    organizationId: r.organizationId ?? null,
    projectId: r.projectId ?? null,
    status: r.status ?? "pending",
    proposedAt: r.proposedAt ?? "",
    proposedBy: r.proposedBy ?? "api",
    path: r.path ?? "/",
    fixes: r.fixes ?? {},
    before: r.before ?? {},
    humanReview: r.humanReview ?? [],
    flags: r.flags ?? [],
    rationale: r.rationale ?? null,
    pulledAt: r.pulledAt ?? null,
  };
}

export async function listHomegrownOttoProposals(input?: {
  status?: HomegrownOttoProposal["status"];
  domain?: string;
  limit?: number;
  // Org-scoped callers (MCP / Sam) see only their own rows. Legacy rows with
  // no organizationId stay visible ONLY because the caller has already proven
  // (resolveProjectByDomain in its org) that `domain` is its project, so pass
  // this together with `domain`, never alone. Omitted = unscoped (Hermes).
  visibleToOrganizationId?: string;
}): Promise<HomegrownOttoProposal[]> {
  const scoped = input?.visibleToOrganizationId !== undefined;
  if (scoped && !input.visibleToOrganizationId?.trim()) {
    throw new Error("visibleToOrganizationId must be a non-empty id");
  }
  if (scoped && !input.domain) {
    throw new Error("visibleToOrganizationId requires domain");
  }
  const limit = Math.min(Math.max(input?.limit ?? 50, 1), 200);
  const index = await readIndex();
  const out: HomegrownOttoProposal[] = [];
  // One KV read per row, sequentially, took ~30 s for a 500-row index (status
  // filters run after the read). Read in parallel batches; rows keep index order.
  for (let at = 0; at < index.length && out.length < limit; at += READ_BATCH) {
    const batch = index.slice(at, at + READ_BATCH);
    const raws = await Promise.all(
      batch.map((id) => kv().get(proposalKey(id))),
    );
    for (const raw of raws) {
      if (out.length >= limit) break;
      if (!raw) continue;
      try {
        const proposal = toProposal(JSON.parse(raw));
        if (!proposal) continue;
        if (input?.status && proposal.status !== input.status) continue;
        if (
          scoped &&
          proposal.organizationId != null &&
          proposal.organizationId !== input.visibleToOrganizationId
        ) {
          continue;
        }
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
      const proposal = JSON.parse(raw) as HomegrownOttoProposal;
      if (proposal.status !== "pending") continue;
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
