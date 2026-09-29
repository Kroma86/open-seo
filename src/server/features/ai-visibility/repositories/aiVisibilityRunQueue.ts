import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { aiVisibilityRuns, projects } from "@/db/schema";

export async function tryCreateRun(data: {
  id: string;
  configId: string;
  projectId: string;
  promptSetVersion: number;
  trigger?: "manual" | "scheduled";
}) {
  const inserted = await db
    .insert(aiVisibilityRuns)
    .values({
      id: data.id,
      configId: data.configId,
      projectId: data.projectId,
      promptSetVersion: data.promptSetVersion,
      status: "pending",
      ...(data.trigger ? { trigger: data.trigger } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: aiVisibilityRuns.id });
  return Boolean(inserted[0]);
}

/** Pending rows a person or API client queued. The scheduled checker finishes them. */
export async function listQueuedManualRuns(limit: number) {
  return db
    .select({
      id: aiVisibilityRuns.id,
      configId: aiVisibilityRuns.configId,
      projectId: aiVisibilityRuns.projectId,
      organizationId: projects.organizationId,
    })
    .from(aiVisibilityRuns)
    .innerJoin(projects, eq(aiVisibilityRuns.projectId, projects.id))
    .where(
      and(
        eq(aiVisibilityRuns.status, "pending"),
        eq(aiVisibilityRuns.trigger, "manual"),
        isNull(projects.archivedAt),
      ),
    )
    .orderBy(asc(aiVisibilityRuns.createdAt), asc(aiVisibilityRuns.id))
    .limit(limit);
}
