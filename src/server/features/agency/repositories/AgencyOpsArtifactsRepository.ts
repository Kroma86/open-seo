import { and, desc, eq } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { agencyOpsArtifacts } from "@/db/schema";

type InsertInput = Pick<
  InferInsertModel<typeof agencyOpsArtifacts>,
  "kind" | "domain" | "date" | "contentType" | "content" | "sourceKey"
>;

async function insertIfNew(
  input: InsertInput,
): Promise<{ id: string; deduped: boolean }> {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(agencyOpsArtifacts)
    .values({ id, ...input })
    .onConflictDoNothing({
      target: [agencyOpsArtifacts.kind, agencyOpsArtifacts.sourceKey],
    })
    .returning({ id: agencyOpsArtifacts.id });

  if (inserted[0]) {
    return { id: inserted[0].id, deduped: false };
  }

  const existing = await db
    .select({ id: agencyOpsArtifacts.id })
    .from(agencyOpsArtifacts)
    .where(
      and(
        eq(agencyOpsArtifacts.kind, input.kind),
        eq(agencyOpsArtifacts.sourceKey, input.sourceKey),
      ),
    )
    .limit(1);

  if (!existing[0]) {
    // Insert conflicted but the conflicting row is not findable (deleted
    // between statements, or a different constraint fired). Surface a
    // retryable server error, never a validation-shaped one.
    throw new Error("ingest_conflict_lookup_failed");
  }
  return { id: existing[0].id, deduped: true };
}

async function list(input: { kind?: InsertInput["kind"]; limit?: number }) {
  const limit = input.limit ?? 50;
  const base = db
    .select({
      id: agencyOpsArtifacts.id,
      kind: agencyOpsArtifacts.kind,
      domain: agencyOpsArtifacts.domain,
      date: agencyOpsArtifacts.date,
      contentType: agencyOpsArtifacts.contentType,
      sourceKey: agencyOpsArtifacts.sourceKey,
      receivedAt: agencyOpsArtifacts.receivedAt,
    })
    .from(agencyOpsArtifacts)
    .orderBy(desc(agencyOpsArtifacts.receivedAt))
    .limit(limit);

  if (input.kind) {
    return base.where(eq(agencyOpsArtifacts.kind, input.kind));
  }
  return base;
}

async function getById(id: string) {
  const rows = await db
    .select()
    .from(agencyOpsArtifacts)
    .where(eq(agencyOpsArtifacts.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function latestByKind(kind: InsertInput["kind"]) {
  const rows = await db
    .select()
    .from(agencyOpsArtifacts)
    .where(eq(agencyOpsArtifacts.kind, kind))
    .orderBy(desc(agencyOpsArtifacts.receivedAt))
    .limit(1);
  return rows[0] ?? null;
}

export const AgencyOpsArtifactsRepository = {
  insertIfNew,
  list,
  getById,
  latestByKind,
};
