/**
 * Prompt rows for AI visibility configs, including the cap-respecting writes.
 * Exposed through `AiVisibilityRepository`; import that, not this module.
 */
import { and, asc, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiVisibilityPrompts } from "@/db/schema";
import { MAX_ACTIVE_PROMPTS_PER_CONFIG } from "@/shared/ai-visibility";

export async function getPromptsForConfig(configId: string) {
  return db
    .select()
    .from(aiVisibilityPrompts)
    .where(eq(aiVisibilityPrompts.configId, configId))
    .orderBy(aiVisibilityPrompts.createdAt);
}

export async function getActivePromptsForConfig(configId: string) {
  return db
    .select()
    .from(aiVisibilityPrompts)
    .where(
      and(
        eq(aiVisibilityPrompts.configId, configId),
        eq(aiVisibilityPrompts.isActive, true),
      ),
    )
    .orderBy(asc(aiVisibilityPrompts.createdAt), asc(aiVisibilityPrompts.id));
}

export async function countActivePromptsForConfig(configId: string) {
  const rows = await db
    .select({ value: count() })
    .from(aiVisibilityPrompts)
    .where(
      and(
        eq(aiVisibilityPrompts.configId, configId),
        eq(aiVisibilityPrompts.isActive, true),
      ),
    );
  return rows[0]?.value ?? 0;
}

export async function addPrompt(data: {
  id: string;
  configId: string;
  prompt: string;
}) {
  const inserted = await db
    .insert(aiVisibilityPrompts)
    .values({ ...data, isActive: true })
    .onConflictDoNothing()
    .returning({ id: aiVisibilityPrompts.id });
  return inserted[0]?.id ?? null;
}

type AddPromptOutcome =
  | { ok: true; promptId: string }
  | { ok: false; reason: "duplicate" | "cap" };

async function repairActivePromptCap(
  configId: string,
  promptId: string,
  mode: "insert" | "activate",
): Promise<"ok" | "cap"> {
  const active = await getActivePromptsForConfig(configId);
  if (active.length <= MAX_ACTIVE_PROMPTS_PER_CONFIG) return "ok";
  const survivors = active
    .slice(0, MAX_ACTIVE_PROMPTS_PER_CONFIG)
    .map((row) => row.id);
  if (survivors.includes(promptId)) return "ok";
  if (mode === "insert") {
    await db
      .delete(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.id, promptId));
  } else {
    await db
      .update(aiVisibilityPrompts)
      .set({ isActive: false })
      .where(eq(aiVisibilityPrompts.id, promptId));
  }
  return "cap";
}

/**
 * Insert an active prompt, then self-repair when concurrent adds exceed the cap.
 * Post-commit ordering by (createdAt, id) ensures at most MAX survive.
 */
export async function addPromptRespectingCap(data: {
  id: string;
  configId: string;
  prompt: string;
}): Promise<AddPromptOutcome> {
  const inserted = await db
    .insert(aiVisibilityPrompts)
    .values({ ...data, isActive: true })
    .onConflictDoNothing()
    .returning({ id: aiVisibilityPrompts.id });
  const promptId = inserted[0]?.id;
  if (!promptId) return { ok: false, reason: "duplicate" };

  const repaired = await repairActivePromptCap(
    data.configId,
    promptId,
    "insert",
  );
  if (repaired === "cap") return { ok: false, reason: "cap" };
  return { ok: true, promptId };
}

type ActivatePromptOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" | "cap" };

export async function activatePromptRespectingCap(
  promptId: string,
  configId: string,
): Promise<ActivatePromptOutcome> {
  const updated = await db
    .update(aiVisibilityPrompts)
    .set({ isActive: true })
    .where(
      and(
        eq(aiVisibilityPrompts.id, promptId),
        eq(aiVisibilityPrompts.configId, configId),
        eq(aiVisibilityPrompts.isActive, false),
      ),
    )
    .returning({ id: aiVisibilityPrompts.id });
  if (!updated[0]) return { ok: false, reason: "not_found" };

  const repaired = await repairActivePromptCap(configId, promptId, "activate");
  if (repaired === "cap") return { ok: false, reason: "cap" };
  return { ok: true };
}

export async function removePrompt(promptId: string, configId: string) {
  const removed = await db
    .delete(aiVisibilityPrompts)
    .where(
      and(
        eq(aiVisibilityPrompts.id, promptId),
        eq(aiVisibilityPrompts.configId, configId),
      ),
    )
    .returning({ id: aiVisibilityPrompts.id });
  return removed[0]?.id ?? null;
}

export async function togglePrompt(
  promptId: string,
  configId: string,
  isActive: boolean,
) {
  const updated = await db
    .update(aiVisibilityPrompts)
    .set({ isActive })
    .where(
      and(
        eq(aiVisibilityPrompts.id, promptId),
        eq(aiVisibilityPrompts.configId, configId),
      ),
    )
    .returning({ id: aiVisibilityPrompts.id });
  return updated[0]?.id ?? null;
}

export async function getPromptById(promptId: string, configId: string) {
  const rows = await db
    .select()
    .from(aiVisibilityPrompts)
    .where(
      and(
        eq(aiVisibilityPrompts.id, promptId),
        eq(aiVisibilityPrompts.configId, configId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
