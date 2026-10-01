import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { getDatabaseProvider } from "@/db/provider";
import { pgDb } from "@/db/pg/client";
import { runD1RawBatch } from "@/db/runBatch";
import { samLoops as pgSamLoops } from "@/db/pg/schema";
import { projects, samLoopRuns, samLoops } from "@/db/schema";
import { hasVerifiedMonthlyDraft } from "../services/monthlyContentResult";
import {
  CONTENT_LOOP_SKILL_NAMES,
  DEFAULT_SAM_LOOP_TEMPLATES,
  computeNextSamLoopRunAt,
} from "@/shared/sam-loops";

async function getLoopsForProject(projectId: string) {
  return db
    .select()
    .from(samLoops)
    .where(eq(samLoops.projectId, projectId))
    .orderBy(samLoops.name);
}

async function getLoopById(loopId: string, projectId: string) {
  const rows = await db
    .select()
    .from(samLoops)
    .where(and(eq(samLoops.id, loopId), eq(samLoops.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

async function createLoop(
  data: Pick<
    InferInsertModel<typeof samLoops>,
    | "id"
    | "projectId"
    | "name"
    | "sourceType"
    | "skillName"
    | "customPrompt"
    | "cadence"
    | "isEnabled"
    | "nextRunAt"
  >,
) {
  const inserted = await db.insert(samLoops).values(data).returning();
  return inserted[0]!;
}

async function updateLoop(
  loopId: string,
  projectId: string,
  data: Partial<
    Pick<
      InferInsertModel<typeof samLoops>,
      | "name"
      | "isEnabled"
      | "cadence"
      | "customPrompt"
      | "skillName"
      | "sourceType"
      | "lastRunAt"
      | "nextRunAt"
    >
  >,
) {
  const updated = await db
    .update(samLoops)
    .set(data)
    .where(and(eq(samLoops.id, loopId), eq(samLoops.projectId, projectId)))
    .returning();
  return updated[0] ?? null;
}

async function getDueLoopsWithOrganization(nowIso: string) {
  return db
    .select({
      id: samLoops.id,
      projectId: samLoops.projectId,
      name: samLoops.name,
      sourceType: samLoops.sourceType,
      skillName: samLoops.skillName,
      customPrompt: samLoops.customPrompt,
      cadence: samLoops.cadence,
      nextRunAt: samLoops.nextRunAt,
      organizationId: projects.organizationId,
      domain: projects.domain,
      loopsEnabled: projects.loopsEnabled,
    })
    .from(samLoops)
    .innerJoin(projects, eq(samLoops.projectId, projects.id))
    .where(
      and(
        eq(samLoops.isEnabled, true),
        lte(samLoops.nextRunAt, nowIso),
        isNull(projects.archivedAt),
      ),
    )
    .orderBy(samLoops.nextRunAt)
    .limit(200);
}

async function claimDueLoop(input: {
  loopId: string;
  projectId: string;
  observedNextRunAt: string;
  nextRunAt: string;
}): Promise<boolean> {
  const claimed = await db
    .update(samLoops)
    .set({ nextRunAt: input.nextRunAt })
    .where(
      and(
        eq(samLoops.id, input.loopId),
        eq(samLoops.projectId, input.projectId),
        eq(samLoops.isEnabled, true),
        eq(samLoops.nextRunAt, input.observedNextRunAt),
      ),
    )
    .returning({ id: samLoops.id });
  return claimed.length > 0;
}

async function tryCreateRun(
  data: {
    id: string;
    loopId: string;
    projectId: string;
  },
  admission?: { sinceDate: string; cap: number },
): Promise<boolean> {
  // Count and insert are one SQLite statement, so parallel D1 invocations
  // cannot both claim the last slot. Postgres needs a transaction lock because
  // its concurrent statement snapshots do not serialize the count by itself.
  if (admission) {
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
  const inserted = await db
    .insert(samLoopRuns)
    .values({ ...data, status: "pending" })
    .onConflictDoNothing()
    .returning({ id: samLoopRuns.id });
  return Boolean(inserted[0]);
}

async function updateRun(
  runId: string,
  data: Partial<InferInsertModel<typeof samLoopRuns>>,
) {
  await db.update(samLoopRuns).set(data).where(eq(samLoopRuns.id, runId));
}

async function compareAndSwapSubscriptionRun(
  runId: string,
  expectedCostNote: string | null,
  data: Partial<InferInsertModel<typeof samLoopRuns>>,
  terminalLoop?: { loopId: string; projectId: string; finishedAt: string },
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

async function claimSubscriptionRun(
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
        await tx.execute(sql`update ${pgSamLoops} set next_run_at = ${input.nextRunAt}
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

async function getRunById(runId: string) {
  const rows = await db
    .select()
    .from(samLoopRuns)
    .where(eq(samLoopRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

async function getActiveRunForLoop(loopId: string) {
  const rows = await db
    .select()
    .from(samLoopRuns)
    .where(
      and(
        eq(samLoopRuns.loopId, loopId),
        inArray(samLoopRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function getRunsForLoop(input: {
  loopId: string;
  projectId: string;
  limit?: number;
}) {
  return db
    .select()
    .from(samLoopRuns)
    .where(
      and(
        eq(samLoopRuns.loopId, input.loopId),
        eq(samLoopRuns.projectId, input.projectId),
      ),
    )
    .orderBy(desc(samLoopRuns.createdAt))
    .limit(input.limit ?? 20);
}

async function getRecentRunsForProject(input: {
  projectId: string;
  limit?: number;
}) {
  return db
    .select({
      id: samLoopRuns.id,
      loopId: samLoopRuns.loopId,
      loopName: samLoops.name,
      status: samLoopRuns.status,
      startedAt: samLoopRuns.startedAt,
      finishedAt: samLoopRuns.finishedAt,
      report: samLoopRuns.report,
      proposalsQueued: samLoopRuns.proposalsQueued,
      costNote: samLoopRuns.costNote,
      error: samLoopRuns.error,
      createdAt: samLoopRuns.createdAt,
    })
    .from(samLoopRuns)
    .innerJoin(samLoops, eq(samLoopRuns.loopId, samLoops.id))
    .where(eq(samLoopRuns.projectId, input.projectId))
    .orderBy(desc(samLoopRuns.createdAt))
    .limit(input.limit ?? 30);
}

async function getContentVelocityForProject(
  projectId: string,
  sinceIso: string,
) {
  const rows = await db
    .select({
      loopId: samLoopRuns.loopId,
      loopName: samLoops.name,
      cadence: samLoops.cadence,
      isEnabled: samLoops.isEnabled,
      finishedAt: samLoopRuns.finishedAt,
      report: samLoopRuns.report,
    })
    .from(samLoopRuns)
    .innerJoin(samLoops, eq(samLoopRuns.loopId, samLoops.id))
    .where(
      and(
        eq(samLoopRuns.projectId, projectId),
        eq(samLoopRuns.status, "completed"),
        isNotNull(samLoopRuns.finishedAt),
        gte(samLoopRuns.finishedAt, sinceIso),
        or(
          and(
            eq(samLoops.sourceType, "custom"),
            eq(
              samLoops.customPrompt,
              DEFAULT_SAM_LOOP_TEMPLATES.find(
                (template) => template.name === "Monthly content",
              )!.customPrompt!,
            ),
          ),
          eq(samLoops.name, "Monthly content"),
          inArray(samLoops.skillName, [...CONTENT_LOOP_SKILL_NAMES]),
        ),
      ),
    );

  return Promise.all(
    rows.map(async (row) => ({
      loopId: row.loopId,
      loopName: row.loopName,
      cadence: row.cadence,
      isEnabled: row.isEnabled,
      finishedAt: row.finishedAt!,
      hasDraft: await hasVerifiedMonthlyDraft(row.report),
    })),
  );
}

/**
 * createdAt is a text column defaulting to sqlite current_timestamp, which
 * stores YYYY-MM-DD HH:MM:SS (space separator, no Z). A full ISO bound
 * YYYY-MM-DDT00:00:00.000Z would compare GREATER than every same-day row
 * (' ' sorts before 'T') and count nothing. The date prefix compares
 * correctly against both the sqlite format and any ISO string.
 */
async function countRunsCreatedSince(sinceDate: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(samLoopRuns)
    .where(gte(samLoopRuns.createdAt, sinceDate));
  return Number(row?.value ?? 0);
}

/**
 * Insert missing default loops for a project. Idempotent via the
 * (projectId, name) unique index — conflicts are skipped (safe under
 * concurrent createProject + listSamLoops seeding).
 */
async function ensureDefaultLoops(projectId: string) {
  const existing = await getLoopsForProject(projectId);
  const existingNames = new Set(existing.map((loop) => loop.name));
  const created = [];

  for (const template of DEFAULT_SAM_LOOP_TEMPLATES) {
    if (existingNames.has(template.name)) continue;
    const inserted = await db
      .insert(samLoops)
      .values({
        id: crypto.randomUUID(),
        projectId,
        name: template.name,
        sourceType: template.sourceType,
        skillName: template.sourceType === "skill" ? template.skillName : null,
        customPrompt:
          template.sourceType === "custom" ? template.customPrompt : null,
        cadence: template.cadence,
        isEnabled: true,
        nextRunAt: computeNextSamLoopRunAt(
          template.cadence,
          undefined,
          `${projectId}:${template.name}`,
        ),
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) created.push(inserted[0]);
  }

  return created;
}

/**
 * Seed default loops for every non-archived project that has none yet.
 * Used by bootstrap / migration follow-up scripts.
 */
async function seedDefaultsForAllProjects() {
  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(isNull(projects.archivedAt));

  let seeded = 0;
  for (const project of projectRows) {
    const created = await ensureDefaultLoops(project.id);
    seeded += created.length;
  }
  return { projects: projectRows.length, loopsCreated: seeded };
}

export const SamLoopRepository = {
  getLoopsForProject,
  getLoopById,
  createLoop,
  updateLoop,
  getDueLoopsWithOrganization,
  claimDueLoop,
  tryCreateRun,
  updateRun,
  compareAndSwapSubscriptionRun,
  claimSubscriptionRun,
  getRunById,
  getActiveRunForLoop,
  getRunsForLoop,
  getRecentRunsForProject,
  getContentVelocityForProject,
  countRunsCreatedSince,
  ensureDefaultLoops,
  seedDefaultsForAllProjects,
};
