import {
  and,
  eq,
  inArray,
  isNull,
  sql,
  type InferInsertModel,
} from "drizzle-orm";
import { db } from "./index";
import { getDatabaseProvider } from "./provider";
import { pgDb } from "./pg/client";
import { runD1RawBatch } from "./runBatch";
import { projects, samLoopRuns, samLoops } from "./schema";

export type SubscriptionHouseScope = {
  projectId: string;
  loopId: string;
  domain: "niceseo.ai";
};

export async function tryCreateAdmittedSamLoopRun(
  data: { id: string; loopId: string; projectId: string },
  admission: { sinceDate: string; cap: number },
): Promise<boolean> {
  const query = sql`insert into ${samLoopRuns} (id, loop_id, project_id, status)
    select ${data.id}, ${data.loopId}, ${data.projectId}, 'pending'
    where (select count(*) from ${samLoopRuns} where ${samLoopRuns.createdAt} >= ${admission.sinceDate}) < ${admission.cap}
    on conflict do nothing returning id`;
  if (getDatabaseProvider() === "postgres") {
    return pgDb.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(734629105)`);
      const rows = await transaction.execute(query);
      return rows.length > 0;
    });
  }
  const rows = await db.all<{ id: string }>(query);
  return rows.length > 0;
}

export async function compareAndSwapSubscriptionRun(
  runId: string,
  expectedCostNote: string | null,
  data: Partial<InferInsertModel<typeof samLoopRuns>>,
  terminalLoop?: { loopId: string; projectId: string; finishedAt: string },
  houseScope?: SubscriptionHouseScope,
) {
  const update = db
    .update(samLoopRuns)
    .set(data)
    .where(
      and(
        eq(samLoopRuns.id, runId),
        inArray(samLoopRuns.status, ["pending", "running"]),
        expectedCostNote === null
          ? isNull(samLoopRuns.costNote)
          : eq(samLoopRuns.costNote, expectedCostNote),
        houseScope
          ? and(
              eq(samLoopRuns.projectId, houseScope.projectId),
              eq(samLoopRuns.loopId, houseScope.loopId),
              sql`exists (select 1 from ${projects} inner join ${samLoops}
                on ${samLoops.projectId} = ${projects.id}
                where ${projects.id} = ${houseScope.projectId} and ${samLoops.id} = ${houseScope.loopId}
                and ${projects.domain} = ${houseScope.domain} and ${projects.archivedAt} is null
                and ${eq(samLoops.isEnabled, true)})`,
            )
          : undefined,
      ),
    )
    .returning({ id: samLoopRuns.id });
  if (terminalLoop) {
    if (
      data.finishedAt !== terminalLoop.finishedAt ||
      !["completed", "failed"].includes(data.status ?? "")
    )
      throw new Error("subscription_terminal_identity_invalid");
    const terminalState = sql`exists (select 1 from ${samLoopRuns} where ${samLoopRuns.id} = ${runId}
      and ${samLoopRuns.loopId} = ${terminalLoop.loopId} and ${samLoopRuns.projectId} = ${terminalLoop.projectId}
      and ${samLoopRuns.status} = ${data.status} and ${samLoopRuns.finishedAt} = ${terminalLoop.finishedAt}
      and ${samLoopRuns.costNote} = ${data.costNote})`;
    const stamp = sql`update ${samLoops} set last_run_at = ${terminalLoop.finishedAt}
      where ${samLoops.id} = ${terminalLoop.loopId} and ${samLoops.projectId} = ${terminalLoop.projectId} and ${terminalState}`;
    if (getDatabaseProvider() === "postgres") {
      return pgDb.transaction(async (transaction) => {
        const updated = await transaction.execute(update.getSQL());
        if (updated.length !== 1) return false;
        const stamped = await transaction.execute(sql`${stamp} returning id`);
        if (stamped.length !== 1)
          throw new Error("subscription_terminal_loop_not_stamped");
        return true;
      });
    }
    const assertion = sql`select case when ${terminalState} and not exists
      (select 1 from ${samLoops} where ${samLoops.id} = ${terminalLoop.loopId}
        and ${samLoops.projectId} = ${terminalLoop.projectId} and ${samLoops.lastRunAt} = ${terminalLoop.finishedAt})
      then abs(-9223372036854775808) else 1 end`;
    const results = await runD1RawBatch([
      update.getSQL(),
      sql`${stamp} and changes() = 1 returning id`,
      assertion,
    ]);
    return results[0]?.results.length === 1 && results[1]?.results.length === 1;
  }
  const rows = await update;
  return rows.length === 1;
}

export async function claimSubscriptionRun(
  input: {
    id: string;
    loopId: string;
    projectId: string;
    scheduledFor: string;
    nextRunAt: string;
    startedAt: string;
    costNote: string;
    domain: string | null;
    loopsEnabled: boolean;
  },
  admission: { sinceDate: string; cap: number },
): Promise<boolean> {
  const domainCheck =
    input.domain === null
      ? sql`${projects.domain} is null`
      : sql`${projects.domain} = ${input.domain}`;
  const createdSince =
    getDatabaseProvider() === "postgres"
      ? sql`${samLoopRuns.createdAt} >= ${admission.sinceDate}`
      : sql`datetime(${samLoopRuns.createdAt}) >= datetime(${admission.sinceDate})`;
  const permission =
    getDatabaseProvider() === "postgres"
      ? input.loopsEnabled
      : Number(input.loopsEnabled);
  const insert = sql`insert into ${samLoopRuns} (id, loop_id, project_id, status, started_at, cost_note, created_at)
    select ${input.id}, ${input.loopId}, ${input.projectId}, 'running', ${input.startedAt}, ${input.costNote}, ${input.startedAt}
    where exists (select 1 from ${samLoops} where ${samLoops.id} = ${input.loopId}
      and ${samLoops.projectId} = ${input.projectId} and ${samLoops.isEnabled} = true
      and ${samLoops.nextRunAt} = ${input.scheduledFor} and ${samLoops.nextRunAt} <= ${input.startedAt})
    and exists (select 1 from ${projects} where ${projects.id} = ${input.projectId}
      and ${projects.archivedAt} is null and ${domainCheck} and ${projects.loopsEnabled} = ${permission})
    and (select count(*) from ${samLoopRuns} where ${createdSince}) < ${admission.cap}
    on conflict do nothing returning id`;
  const scheduleCondition = and(
    eq(samLoops.id, input.loopId),
    eq(samLoops.projectId, input.projectId),
    eq(samLoops.nextRunAt, input.scheduledFor),
    sql`exists (select 1 from ${samLoopRuns} where ${samLoopRuns.id} = ${input.id}
      and ${samLoopRuns.loopId} = ${input.loopId} and ${samLoopRuns.projectId} = ${input.projectId}
      and ${samLoopRuns.status} = 'running' and ${samLoopRuns.costNote} = ${input.costNote}
      and ${samLoopRuns.startedAt} = ${input.startedAt} and ${samLoopRuns.createdAt} = ${input.startedAt})`,
  );
  if (getDatabaseProvider() === "postgres") {
    return pgDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(734629105)`);
      const rows = await tx.execute(insert);
      if (!rows.length) return false;
      const advanced =
        await tx.execute(sql`update ${samLoops} set next_run_at = ${input.nextRunAt}
        where ${scheduleCondition} returning id`);
      if (advanced.length !== 1)
        throw new Error("subscription_schedule_not_advanced");
      return true;
    });
  }
  const updateQuery = db
    .update(samLoops)
    .set({ nextRunAt: input.nextRunAt })
    .where(and(scheduleCondition, sql`changes() = 1`))
    .returning({ id: samLoops.id })
    .getSQL();
  const assertScheduleAdvanced = sql`select case when exists
    (select 1 from ${samLoopRuns} where ${samLoopRuns.id} = ${input.id}
      and ${samLoopRuns.costNote} = ${input.costNote} and ${samLoopRuns.startedAt} = ${input.startedAt})
    and not exists (select 1 from ${samLoops} where ${samLoops.id} = ${input.loopId}
      and ${samLoops.projectId} = ${input.projectId} and ${samLoops.nextRunAt} = ${input.nextRunAt})
    then abs(-9223372036854775808) else 1 end`;
  const results = await runD1RawBatch([
    insert,
    updateQuery,
    assertScheduleAdvanced,
  ]);
  return results[0]?.results.length === 1 && results[1]?.results.length === 1;
}
