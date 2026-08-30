/**
 * HomeGrown OTTO fix proposals queued by SAM / MCP.
 * Stored in Workers KV. Hermes pulls them into OTTO pending/ — nothing deploys
 * from this layer. Jon's OTTO gate remains the only path to approved/.
 */
import { env } from "cloudflare:workers";

const KEY_PREFIX = "homegrown-otto:proposal:";
const INDEX_KEY = "homegrown-otto:proposal-index";
const MAX_INDEX = 500;

export type HomegrownOttoProposal = {
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

export async function listHomegrownOttoProposals(input?: {
  status?: HomegrownOttoProposal["status"];
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
      const proposal = JSON.parse(raw) as HomegrownOttoProposal;
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
