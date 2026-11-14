import { z } from "zod";
import { runBatch } from "@/db/runBatch";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  measurementEnrollments as enrollments,
  measurementRuns as runs,
  measurementAnswers as answers,
  measurementCitations as citations,
} from "@/db/schema";
import {
  createDataforseoClient,
  loadDataforseoSections,
} from "@/server/lib/dataforseo/client";
import { isTaskInProgress } from "@/server/lib/dataforseo/envelope";
import { MEASUREMENT_V2, validateEnrollments } from "./policy";
import { measurementGate } from "./gate";
import {
  reserveMeasurementRun,
  recordMeasurementCost,
  assertMeasurementBudget,
} from "./repository";
import { parseMeasurement, type Engine } from "./match";

async function collectMeasurementAnswers(now: Date) {
  const outstanding = await db
    .select({ answer: answers, run: runs })
    .from(answers)
    .innerJoin(runs, eq(answers.runId, runs.id))
    .where(eq(answers.status, "posted"))
    .orderBy(asc(answers.postedAt))
    .limit(20);
  for (const { answer, run } of outstanding) {
    if (
      !answer.taskId ||
      !answer.postedAt ||
      !Number.isFinite(Date.parse(answer.postedAt)) ||
      now.getTime() - Date.parse(answer.postedAt) > 24 * 3600000
    ) {
      await db
        .update(answers)
        .set({ status: "timeout" })
        .where(and(eq(answers.id, answer.id), eq(answers.status, "posted")));
      continue;
    }
    try {
      const task = await (
        await loadDataforseoSections()
      ).getMeasurementTask({ engine: answer.engine, taskId: answer.taskId });
      if (isTaskInProgress({ status_code: task.status_code })) continue;
      const parsed =
        task.status_code === 20000 && task.result?.length === 1
          ? parseMeasurement(
              answer.engine,
              task.result[0],
              run.brand,
              run.domain,
            )
          : null;
      const status =
        task.status_code !== 20000
          ? "error"
          : parsed
            ? "completed"
            : "unparsed";
      await runBatch((tx) => [
        ...(parsed?.citedDomains ?? []).map((domain) =>
          tx
            .insert(citations)
            .values({
              id: `${answer.id}:${domain}`,
              answerId: answer.id,
              domain,
            })
            .onConflictDoNothing(),
        ),
        tx
          .update(answers)
          .set({
            status,
            named: parsed?.named ?? null,
            cited: parsed?.cited ?? null,
            channels: parsed?.channels.join(",") ?? null,
          })
          .where(and(eq(answers.id, answer.id), eq(answers.status, "posted"))),
      ]);
    } catch (error) {
      if (error instanceof z.ZodError) {
        await db
          .update(answers)
          .set({ status: "unparsed" })
          .where(and(eq(answers.id, answer.id), eq(answers.status, "posted")));
        continue;
      }
      // Transient collection failures retain the task for the next free poll.
      console.info("[measurement-v2] collection held; no submission replay");
    }
  }
}

export async function runMeasurementV2Tick(now = new Date()) {
  if (!MEASUREMENT_V2.enabled) return;
  const stored = await db.select().from(enrollments);
  await collectMeasurementAnswers(now);
  const collecting = await db
    .select()
    .from(runs)
    .where(inArray(runs.status, ["posting", "collecting"]));
  for (const run of collecting) {
    const rows = await db
      .select()
      .from(answers)
      .where(eq(answers.runId, run.id));
    // A crash before recording a provider task is uncertain work, never reposted.
    if (now.getTime() - Date.parse(run.createdAt) > 24 * 3600000)
      await db
        .update(answers)
        .set({ status: "timeout" })
        .where(and(eq(answers.runId, run.id), eq(answers.status, "planned")));
    if (
      rows.length === run.answers &&
      rows.every((a) => !["planned", "posted"].includes(a.status))
    )
      await db
        .update(runs)
        .set({ status: "completed" })
        .where(eq(runs.id, run.id));
  }
  const valid = validateEnrollments(stored, now, !MEASUREMENT_V2.dryRun);
  for (const e of valid) {
    try {
      const gated = await measurementGate(e, now);
      console.info("[measurement-v2] preflight", {
        answers: gated.estimate.answers,
        rawCredits: gated.estimate.rawCredits,
        billedCredits: gated.estimate.credits,
        dryRun: MEASUREMENT_V2.dryRun,
      });
      if (MEASUREMENT_V2.dryRun) {
        await db
          .update(enrollments)
          .set({ dryRunAt: now.toISOString(), dryRunHash: gated.fingerprint })
          .where(eq(enrollments.projectId, e.projectId));
        continue;
      }
      if (!MEASUREMENT_V2.spendBoundVerified)
        throw new Error(
          "Activation held: verified provider maximum charge required for hard spend cap",
        );
      if (e.dryRunHash !== gated.fingerprint)
        throw new Error("Dry run does not cover current plan");
      const run = await reserveMeasurementRun(
        e.projectId,
        gated.questions.length,
        now,
        {
          brand: gated.config.brand,
          domain: e.domain,
          configId: e.configId,
          pilotStartsAt: e.startsAt,
        },
      );
      if (!run) continue;
      const planned = (["chatgpt", "ai_mode"] as Engine[]).flatMap((engine) =>
        gated.questions.flatMap((q) =>
          Array.from({ length: engine === "chatgpt" ? 3 : 1 }, (_, i) => ({
            id: crypto.randomUUID(),
            runId: run.id,
            promptId: q.promptId,
            prompt: q.prompt,
            engine,
            repeat: i + 1,
            status: "planned" as const,
          })),
        ),
      );
      for (const a of planned)
        await db.insert(answers).values({
          id: a.id,
          runId: a.runId,
          promptId: a.promptId,
          prompt: a.prompt,
          engine: a.engine,
          repeat: a.repeat,
          status: a.status,
        });
      for (const engine of ["chatgpt", "ai_mode"] as Engine[]) {
        const batch = planned.filter((a) => a.engine === engine);
        // Check current holds and immutable Context again immediately before spending.
        const fresh = await measurementGate(e, new Date());
        if (fresh.fingerprint !== gated.fingerprint)
          throw new Error("Plan changed before post");
        validateEnrollments(
          await db.select().from(enrollments),
          new Date(),
          true,
        );
        await assertMeasurementBudget(run.week);
        const client = createDataforseoClient({
          userId: "system",
          userEmail: "system@openseo.so",
          organizationId: gated.project.organizationId,
          projectId: e.projectId,
        });
        try {
          await client.measurement.taskPost({
            engine,
            locationCode: gated.project.locationCode,
            languageCode: gated.project.languageCode,
            tasks: batch.map((a) => ({ id: a.id, prompt: a.prompt })),
            persistPosted: async (posted) => {
              await Promise.all(
                batch.map(async (a) => {
                  const matches = posted.tasks.filter(
                    (t) => t.data?.tag === a.id,
                  );
                  const t = matches.length === 1 ? matches[0] : undefined;
                  await db
                    .update(answers)
                    .set(
                      t?.id && t.status_code === 20100
                        ? {
                            status: "posted",
                            taskId: t.id,
                            postedAt: now.toISOString(),
                          }
                        : { status: "error" },
                    )
                    .where(eq(answers.id, a.id));
                }),
              );
              await recordMeasurementCost(run.id, posted.credits);
            },
          });
        } catch {
          await db
            .update(answers)
            .set({ status: "error" })
            .where(
              and(eq(answers.runId, run.id), eq(answers.status, "planned")),
            );
          await db
            .update(runs)
            .set({
              reason:
                "Submission uncertain or failed; reservation retained; no automatic retry",
            })
            .where(eq(runs.id, run.id));
          break;
        }
      }
      await db
        .update(runs)
        .set({ status: "collecting" })
        .where(eq(runs.id, run.id));
    } catch {
      console.info(
        "[measurement-v2] preflight refused; missing or changed eligibility, Context, questions or access",
      );
    }
  }
}
