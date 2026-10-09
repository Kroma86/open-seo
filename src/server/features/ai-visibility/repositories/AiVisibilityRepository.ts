import { and, asc, desc, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { aiVisibilityConfigs, aiVisibilityRuns, projects } from "@/db/schema";
import {
  activatePromptRespectingCap,
  addPrompt,
  addPromptRespectingCap,
  countActivePromptsForConfig,
  getActivePromptsForConfig,
  getPromptById,
  getPromptsForConfig,
  removePrompt,
  togglePrompt,
} from "@/server/features/ai-visibility/repositories/aiVisibilityPromptQueries";

const DUE_CONFIGS_PER_TICK = 500;

async function getConfigsForProject(projectId: string) {
  return db
    .select()
    .from(aiVisibilityConfigs)
    .where(
      and(
        eq(aiVisibilityConfigs.projectId, projectId),
        eq(aiVisibilityConfigs.isActive, true),
      ),
    )
    .orderBy(aiVisibilityConfigs.createdAt);
}

async function getConfigById({
  configId,
  projectId,
}: {
  configId: string;
  projectId: string;
}) {
  const rows = await db
    .select()
    .from(aiVisibilityConfigs)
    .where(
      and(
        eq(aiVisibilityConfigs.id, configId),
        eq(aiVisibilityConfigs.projectId, projectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function getConfigByProjectBrand(projectId: string, brand: string) {
  const rows = await db
    .select()
    .from(aiVisibilityConfigs)
    .where(
      and(
        eq(aiVisibilityConfigs.projectId, projectId),
        eq(aiVisibilityConfigs.brand, brand),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function createConfig(
  data: InferInsertModel<typeof aiVisibilityConfigs>,
) {
  await db.insert(aiVisibilityConfigs).values(data);
}

async function updateConfig(
  configId: string,
  projectId: string,
  data: Partial<InferInsertModel<typeof aiVisibilityConfigs>>,
) {
  await db
    .update(aiVisibilityConfigs)
    .set(data)
    .where(
      and(
        eq(aiVisibilityConfigs.id, configId),
        eq(aiVisibilityConfigs.projectId, projectId),
      ),
    );
}

async function bumpPromptSetVersion(configId: string, projectId: string) {
  const config = await getConfigById({ configId, projectId });
  if (!config) return null;
  const nextVersion = config.promptSetVersion + 1;
  await updateConfig(configId, projectId, {
    promptSetVersion: nextVersion,
  });
  return nextVersion;
}

async function getDueConfigsWithOrganization(nowIso: string) {
  return db
    .select({
      id: aiVisibilityConfigs.id,
      projectId: aiVisibilityConfigs.projectId,
      brand: aiVisibilityConfigs.brand,
      competitors: aiVisibilityConfigs.competitors,
      platforms: aiVisibilityConfigs.platforms,
      scheduleInterval: aiVisibilityConfigs.scheduleInterval,
      promptSetVersion: aiVisibilityConfigs.promptSetVersion,
      nextRunAt: aiVisibilityConfigs.nextRunAt,
      organizationId: projects.organizationId,
    })
    .from(aiVisibilityConfigs)
    .innerJoin(projects, eq(aiVisibilityConfigs.projectId, projects.id))
    .where(
      and(
        eq(aiVisibilityConfigs.isActive, true),
        ne(aiVisibilityConfigs.scheduleInterval, "manual"),
        lte(aiVisibilityConfigs.nextRunAt, nowIso),
        isNull(projects.archivedAt),
      ),
    )
    .orderBy(asc(aiVisibilityConfigs.nextRunAt), asc(aiVisibilityConfigs.id))
    .limit(DUE_CONFIGS_PER_TICK);
}

async function claimDueConfig(input: {
  configId: string;
  projectId: string;
  observedNextRunAt: string;
  nextRunAt: string;
}): Promise<boolean> {
  const claimed = await db
    .update(aiVisibilityConfigs)
    .set({ nextRunAt: input.nextRunAt })
    .where(
      and(
        eq(aiVisibilityConfigs.id, input.configId),
        eq(aiVisibilityConfigs.projectId, input.projectId),
        eq(aiVisibilityConfigs.isActive, true),
        eq(aiVisibilityConfigs.nextRunAt, input.observedNextRunAt),
      ),
    )
    .returning({ id: aiVisibilityConfigs.id });
  return claimed.length > 0;
}

async function tryCreateRun(data: {
  id: string;
  configId: string;
  projectId: string;
  promptSetVersion: number;
}) {
  const inserted = await db
    .insert(aiVisibilityRuns)
    .values({ ...data, status: "pending" })
    .onConflictDoNothing()
    .returning({ id: aiVisibilityRuns.id });
  return Boolean(inserted[0]);
}

async function updateRun(
  runId: string,
  data: Partial<InferInsertModel<typeof aiVisibilityRuns>>,
) {
  await db
    .update(aiVisibilityRuns)
    .set(data)
    .where(eq(aiVisibilityRuns.id, runId));
}

/** Compare-and-swap terminal updates so a reclaimed run cannot accept results. */
async function updateRunIfInFlight(
  runId: string,
  data: Partial<InferInsertModel<typeof aiVisibilityRuns>>,
  options: { requireRunning: boolean },
): Promise<boolean> {
  const statusFilter = options.requireRunning
    ? eq(aiVisibilityRuns.status, "running")
    : inArray(aiVisibilityRuns.status, ["pending", "running"]);
  const updated = await db
    .update(aiVisibilityRuns)
    .set(data)
    .where(and(eq(aiVisibilityRuns.id, runId), statusFilter))
    .returning({ id: aiVisibilityRuns.id });
  return updated.length > 0;
}

async function getRunById(runId: string) {
  const rows = await db
    .select()
    .from(aiVisibilityRuns)
    .where(eq(aiVisibilityRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

async function getActiveRunForConfig(configId: string) {
  const rows = await db
    .select()
    .from(aiVisibilityRuns)
    .where(
      and(
        eq(aiVisibilityRuns.configId, configId),
        inArray(aiVisibilityRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function getLatestCompletedRunForConfig(configId: string) {
  const rows = await db
    .select()
    .from(aiVisibilityRuns)
    .where(
      and(
        eq(aiVisibilityRuns.configId, configId),
        eq(aiVisibilityRuns.status, "completed"),
      ),
    )
    .orderBy(desc(aiVisibilityRuns.finishedAt))
    .limit(1);
  return rows[0] ?? null;
}

async function getCompletedRunsForConfig(configId: string, limit: number) {
  return db
    .select()
    .from(aiVisibilityRuns)
    .where(
      and(
        eq(aiVisibilityRuns.configId, configId),
        eq(aiVisibilityRuns.status, "completed"),
      ),
    )
    .orderBy(desc(aiVisibilityRuns.finishedAt))
    .limit(limit);
}

export const AiVisibilityRepository = {
  getConfigsForProject,
  getConfigById,
  getConfigByProjectBrand,
  createConfig,
  updateConfig,
  bumpPromptSetVersion,
  getDueConfigsWithOrganization,
  claimDueConfig,
  tryCreateRun,
  updateRun,
  updateRunIfInFlight,
  getRunById,
  getActiveRunForConfig,
  getLatestCompletedRunForConfig,
  getCompletedRunsForConfig,
  getPromptsForConfig,
  getActivePromptsForConfig,
  countActivePromptsForConfig,
  addPrompt,
  addPromptRespectingCap,
  activatePromptRespectingCap,
  removePrompt,
  togglePrompt,
  getPromptById,
};
