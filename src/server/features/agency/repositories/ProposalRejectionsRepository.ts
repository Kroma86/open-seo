import { eq, inArray } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { db } from "@/db";
import { proposalRejections } from "@/db/schema";

export type ProposalRejection = InferSelectModel<typeof proposalRejections>;

async function findByIds(ids: string[]): Promise<ProposalRejection[]> {
  if (ids.length > 75) throw new Error("rejection_lookup_limit");
  if (!ids.length) return [];
  return db
    .select()
    .from(proposalRejections)
    .where(inArray(proposalRejections.proposalId, ids));
}

// Atomic first-writer-wins. No updates, deletes, or overwrite-on-conflict.
async function insertIfAbsent(
  row: ProposalRejection,
): Promise<ProposalRejection> {
  const inserted = await db
    .insert(proposalRejections)
    .values(row)
    .onConflictDoNothing({ target: proposalRejections.proposalId })
    .returning();
  if (inserted[0]) return inserted[0];
  const existing = await db
    .select()
    .from(proposalRejections)
    .where(eq(proposalRejections.proposalId, row.proposalId))
    .limit(1);
  if (!existing[0]) throw new Error("rejection_conflict_lookup_failed");
  return existing[0];
}

export const ProposalRejectionsRepository = { findByIds, insertIfAbsent };
