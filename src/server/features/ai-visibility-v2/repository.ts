import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  measurementBudgets as budgets,
  measurementRuns as runs,
} from "@/db/schema";
import { CAPS, estimateAnswers, weekStart } from "./policy";

export async function reserveMeasurementRun(
  projectId: string,
  questionCount: number,
  now: Date,
  snapshot: {
    brand: string;
    domain: string;
    configId: string;
    pilotStartsAt: string;
  },
) {
  let estimate;
  try {
    estimate = estimateAnswers(questionCount);
  } catch {
    console.info("[measurement-v2] refused estimate", {
      questionCount,
      answers: questionCount * 4,
      credits: questionCount * 4 * CAPS.creditsPerAnswer,
    });
    throw new Error("Run estimate invalid or exceeds caps; nothing posted");
  }
  console.info("[measurement-v2] estimate", {
    answers: estimate.answers,
    rawCredits: estimate.rawCredits,
    billedCredits: estimate.credits,
    over2000: estimate.credits > 2000,
  });
  const week = weekStart(now);
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(runs)
    .values({
      id,
      ...snapshot,
      projectId,
      week,
      status: "reserved",
      answers: estimate.answers,
      reservedBilledCreditHundredths: Math.round(estimate.credits * 100),
      createdAt: now.toISOString(),
    })
    .onConflictDoNothing()
    .returning({ id: runs.id });
  if (!inserted.length) return null;
  await db.insert(budgets).values({ week }).onConflictDoNothing();
  // One conditional UPDATE serializes reservations on both D1 and Postgres.
  // A crash consumes capacity rather than releasing a possibly billed request.
  const reserved = await db
    .update(budgets)
    .set({
      answers: sql`${budgets.answers} + ${estimate.answers}`,
      billedCreditHundredths: sql`${budgets.billedCreditHundredths} + ${Math.round(estimate.credits * 100)}`,
    })
    .where(
      and(
        eq(budgets.week, week),
        lte(budgets.answers, CAPS.answersPerWeek - estimate.answers),
        eq(budgets.held, false),
        lte(
          budgets.billedCreditHundredths,
          Math.round((CAPS.creditsPerWeek - estimate.credits) * 100),
        ),
      ),
    )
    .returning({ week: budgets.week });
  if (!reserved.length) {
    await db
      .update(runs)
      .set({
        status: "refused",
        reason: "Weekly cap would be exceeded; nothing posted",
      })
      .where(eq(runs.id, id));
    console.info("[measurement-v2] refused: weekly cap");
    return null;
  }
  await db.update(runs).set({ status: "posting" }).where(eq(runs.id, id));
  return { id, week, ...estimate };
}
export async function recordMeasurementCost(id: string, credits: number) {
  if (!Number.isFinite(credits) || credits < 0)
    throw new Error("Invalid task cost");
  const [run] = await db
    .update(runs)
    .set({
      actualBilledCreditHundredths: sql`${runs.actualBilledCreditHundredths} + ${Math.round(credits * 100)}`,
    })
    .where(eq(runs.id, id))
    .returning();
  if (!run) throw new Error("Missing measurement reservation");
  if (run.actualBilledCreditHundredths > run.reservedBilledCreditHundredths) {
    const overage =
      run.actualBilledCreditHundredths - run.reservedBilledCreditHundredths;
    const previousOverage = Math.max(0, overage - Math.round(credits * 100));
    await db
      .update(budgets)
      .set({
        held: true,
        billedCreditHundredths: sql`${budgets.billedCreditHundredths} + ${overage - previousOverage}`,
      })
      .where(eq(budgets.week, run.week));
    throw new Error("Provider cost exceeded reservation; weekly posting held");
  }
}

export async function assertMeasurementBudget(week: string) {
  const [budget] = await db
    .select()
    .from(budgets)
    .where(eq(budgets.week, week));
  if (
    !budget ||
    budget.held ||
    budget.answers > CAPS.answersPerWeek ||
    budget.billedCreditHundredths > CAPS.creditsPerWeek * 100
  )
    throw new Error("Measurement weekly budget held before task_post");
}
