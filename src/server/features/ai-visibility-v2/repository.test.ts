import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { measurementBudgets, measurementRuns } from "@/db/schema";
import {
  reserveMeasurementRun as reserve,
  recordMeasurementCost,
  assertMeasurementBudget,
} from "./repository";
import { estimateAnswers, withinWeeklyCaps, weekStart } from "./policy";
vi.mock("@/db/schema", async () => ({
  ...(await import("@/db/app.schema")),
  ...(await import("@/db/measurement.schema")),
}));
vi.mock("@/db", async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  return { db: drizzle(createClient({ url: "file::memory:" })) };
});
async function reserveMeasurementRun(
  projectId: string,
  questionCount: number,
  at: Date,
) {
  return reserve(projectId, questionCount, at, {
    brand: "Example",
    domain: "example.test",
    configId: "synthetic-config",
    pilotStartsAt: now.toISOString(),
  });
}
const now = new Date("2026-11-13T12:00:00Z");
beforeAll(async () => {
  await db.run(sql.raw("PRAGMA foreign_keys=OFF"));
  for (const statement of readFileSync(
    "drizzle/0047_measurement_v2.sql",
    "utf8",
  ).split("--> statement-breakpoint"))
    await db.run(sql.raw(statement));
});
beforeEach(async () => {
  await db.run(sql`DELETE FROM measurement_runs`);
  await db.run(sql`DELETE FROM measurement_budgets`);
});
describe("durable pre-post caps", () => {
  it("accepts exactly 300 answers/460.8 billed credits and refuses the next client", async () => {
    for (let i = 0; i < 5; i++)
      expect(
        await reserveMeasurementRun(`synthetic-${i}`, 15, now),
      ).not.toBeNull();
    expect(await reserveMeasurementRun("synthetic-over", 10, now)).toBeNull();
    const [budget] = await db.select().from(measurementBudgets);
    expect(budget).toMatchObject({
      answers: 300,
      billedCreditHundredths: 46080,
    });
    const rows = await db.select().from(measurementRuns);
    expect(rows.filter((r) => r.status === "posting")).toHaveLength(5);
    expect(rows.find((r) => r.projectId === "synthetic-over")?.status).toBe(
      "refused",
    );
  });
  it("allows only one concurrent reservation for a client/week", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        reserveMeasurementRun("synthetic-one", 15, now),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      (await db.select().from(measurementBudgets))[0].billedCreditHundredths,
    ).toBe(9216);
  });
  it("retains unknown submission capacity and stops the week when actual spend exceeds estimate", async () => {
    const run = await reserveMeasurementRun("synthetic-one", 15, now);
    expect(run).not.toBeNull();
    await expect(recordMeasurementCost(run!.id, 109)).rejects.toThrow(
      "exceeded reservation",
    );
    await expect(assertMeasurementBudget(weekStart(now))).rejects.toThrow(
      "held",
    );
    expect(await reserveMeasurementRun("synthetic-two", 10, now)).toBeNull();
  });
  it("refuses invalid question counts before creating a run", async () => {
    await expect(
      reserveMeasurementRun("synthetic-one", 16, now),
    ).rejects.toThrow();
    expect(await db.select().from(measurementRuns)).toHaveLength(0);
    expect(estimateAnswers(15)).toEqual({
      answers: 60,
      rawCredits: 72,
      credits: 92.16,
    });
    expect(withinWeeklyCaps(300, 540)).toBe(true);
    expect(withinWeeklyCaps(301, 540)).toBe(false);
    expect(withinWeeklyCaps(300, 540.01)).toBe(false);
    expect(weekStart(new Date("2027-01-01T00:00:00Z"))).toBe("2026-12-28");
  });
});
it("honours the exact hard 540 billed-credit boundary, independently of answer capacity", async () => {
  await db
    .insert(measurementBudgets)
    .values({ week: weekStart(now), billedCreditHundredths: 47856 });
  expect(
    await reserveMeasurementRun("synthetic-exact", 10, now),
  ).not.toBeNull();
  const [budget] = await db.select().from(measurementBudgets);
  expect(budget.billedCreditHundredths).toBe(54000);
  expect(await reserveMeasurementRun("synthetic-next", 10, now)).toBeNull();
});
it("allows only one run in the seven-day pilot even across a Monday", async () => {
  expect(
    await reserveMeasurementRun("synthetic-pilot", 15, now),
  ).not.toBeNull();
  expect(
    await reserveMeasurementRun(
      "synthetic-pilot",
      15,
      new Date("2026-11-16T12:00:00Z"),
    ),
  ).toBeNull();
});
