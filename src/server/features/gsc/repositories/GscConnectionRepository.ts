import { and, eq, isNull, notExists, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { account, gscConnections } from "@/db/schema";
import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";

export type GscConnection = typeof gscConnections.$inferSelect;

async function getByProjectId(
  projectId: string,
): Promise<GscConnection | null> {
  const rows = await db
    .select()
    .from(gscConnections)
    .where(eq(gscConnections.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

async function upsert(input: {
  projectId: string;
  organizationId: string;
  siteUrl: string;
  connectedByUserId: string;
  gscAccountId: string;
  connectedAccountEmail: string | null;
}): Promise<GscConnection> {
  const [row] = await db
    .insert(gscConnections)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoUpdate({
      target: gscConnections.projectId,
      set: {
        siteUrl: input.siteUrl,
        organizationId: input.organizationId,
        connectedByUserId: input.connectedByUserId,
        gscAccountId: input.gscAccountId,
        connectedAccountEmail: sql`coalesce(${input.connectedAccountEmail}, ${gscConnections.connectedAccountEmail})`,
        updatedAt: sql`(current_timestamp)`,
      },
    })
    .returning();
  if (!row) {
    throw new Error("Failed to upsert gsc_connection");
  }
  return row;
}

async function deleteByProjectId(projectId: string): Promise<void> {
  await db
    .delete(gscConnections)
    .where(eq(gscConnections.projectId, projectId));
}

async function deleteUnusedGrant(
  userId: string,
  accountId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.accountId, accountId),
        eq(account.providerId, GSC_OAUTH_PROVIDER_ID),
        notExists(
          db
            .select({ id: gscConnections.id })
            .from(gscConnections)
            .where(
              and(
                eq(gscConnections.connectedByUserId, account.userId),
                or(
                  eq(gscConnections.gscAccountId, account.accountId),
                  isNull(gscConnections.gscAccountId),
                ),
              ),
            ),
        ),
      ),
    )
    .returning({ id: account.id });
  return deleted.length > 0;
}

export const GscConnectionRepository = {
  getByProjectId,
  upsert,
  deleteByProjectId,
  deleteUnusedGrant,
};
