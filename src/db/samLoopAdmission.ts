import { sql } from "drizzle-orm";
import { db } from "./index";
import { getDatabaseProvider } from "./provider";
import { pgDb } from "./pg/client";
import { samLoopRuns } from "./schema";

// Dialect seam for the daily-cap admission insert: it needs a Postgres
// transaction lock, so it lives under src/db where the dialect clients may be
// imported (see the no-restricted-imports rule in .oxlintrc.json).
export async function tryCreateAdmittedSamLoopRun(
  data: { id: string; loopId: string; projectId: string },
  admission: { sinceDate: string; cap: number },
): Promise<boolean> {
  // Count and insert are one SQLite statement, so parallel D1 invocations
  // cannot both claim the last slot. Postgres needs a transaction lock because
  // its concurrent statement snapshots do not serialize the count by itself.
  const query = sql`insert into ${samLoopRuns} (id, loop_id, project_id, status)
    select ${data.id}, ${data.loopId}, ${data.projectId}, 'pending'
    where (select count(*) from ${samLoopRuns} where ${samLoopRuns.createdAt} >= ${admission.sinceDate}) < ${admission.cap}
    on conflict do nothing returning id`;
  if (getDatabaseProvider() === "postgres") {
    return pgDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(734629105)`);
      const rows = await tx.execute(query);
      return rows.length > 0;
    });
  }
  const rows = await db.all<{ id: string }>(query);
  return rows.length > 0;
}
