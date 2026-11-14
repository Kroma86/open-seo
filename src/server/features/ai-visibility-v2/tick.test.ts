import { z } from "zod";
import type { postMeasurementTasks } from "@/server/lib/dataforseo/measurement";
import type * as Policy from "./policy";
import { weekStart } from "./policy";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  measurementAnswers,
  measurementBudgets,
  measurementEnrollments,
} from "@/db/schema";
import { runMeasurementV2Tick } from "./tick";
const m = vi.hoisted(() => ({
  hosted: false,
  enabled: false,
  dryRun: true,
  spendBoundVerified: true,
  post: vi.fn<
    (input: Parameters<typeof postMeasurementTasks>[0]) => Promise<{
      credits: number;
      tasks: {
        id: string;
        status_code: number;
        cost: number;
        data: { tag: string };
      }[];
    }>
  >(),
  get: vi.fn(),
  gate: vi.fn(),
  credits: vi.fn(),
  cache: vi.fn(),
}));
vi.mock("@/db/schema", async () => ({
  ...(await import("@/db/app.schema")),
  ...(await import("@/db/measurement.schema")),
}));
vi.mock("@/db", async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  return { db: drizzle(createClient({ url: "file::memory:" })) };
});
vi.mock("@/db/runBatch", () => ({
  runBatch: async (build: (tx: typeof db) => readonly Promise<unknown>[]) => {
    for (const statement of build(db)) await statement;
  },
}));
vi.mock("./policy", async (importOriginal) => {
  const actual = await importOriginal<typeof Policy>();
  return {
    ...actual,
    MEASUREMENT_V2: {
      get enabled() {
        return m.enabled;
      },
      get spendBoundVerified() {
        return m.spendBoundVerified;
      },
      get dryRun() {
        return m.dryRun;
      },
    },
    validateEnrollments: () =>
      Array.from({ length: 5 }, (_, i) => ({
        projectId: `00000000-0000-4000-8000-00000000000${i}`,
        configId: "00000000-0000-4000-8000-000000000099",
        startsAt: "2026-11-13T00:00:00Z",
        domain: "example.test",
        dryRunHash: "a".repeat(64),
      })),
  };
});
vi.mock("./gate", () => ({ measurementGate: m.gate }));
vi.mock("@/server/lib/r2-cache", () => ({
  getCached: m.cache,
  setCached: m.cache,
  buildCacheKey: m.cache,
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: async () => m.hosted,
}));
vi.mock("@/server/billing/subscription", () => ({
  getOrCreateOrganizationCustomer: m.credits,
  assertUsageCreditsAvailable: m.credits,
  trackUsageCreditSpend: m.credits,
}));
vi.mock("@/server/lib/dataforseo/sections", () => ({
  postMeasurementTasks: async (
    input: Parameters<typeof postMeasurementTasks>[0],
  ) => {
    const data = await m.post(input);
    await input.persistPosted({
      ...data,
      rawCredits: input.tasks.length * 1.2,
    });
    return {
      data,
      billing: {
        costUsd: input.tasks.length * 0.0012,
        path: ["v3", "ai_optimization", "chat_gpt", "llm_scraper", "task_post"],
      },
    };
  },
  getMeasurementTask: m.get,
}));
beforeAll(async () => {
  await db.run(sql.raw("PRAGMA foreign_keys=OFF"));
  for (const statement of readFileSync(
    "drizzle/0047_measurement_v2.sql",
    "utf8",
  ).split("--> statement-breakpoint"))
    await db.run(sql.raw(statement));
});
beforeEach(async () => {
  for (const table of [
    "measurement_answers",
    "measurement_citations",
    "measurement_runs",
    "measurement_budgets",
    "measurement_enrollments",
  ])
    await db.run(sql.raw(`DELETE FROM ${table}`));
  for (let i = 0; i < 5; i++)
    await db.insert(measurementEnrollments).values({
      projectId: `00000000-0000-4000-8000-00000000000${i}`,
      configId: "00000000-0000-4000-8000-000000000099",
      domain: "example.test",
      contextHash: "a".repeat(64),
      eligibilityEvidence: "synthetic",
      eligibilityHash: "b".repeat(64),
      verifiedAt: new Date().toISOString(),
      startsAt: new Date().toISOString(),
      dryRunHash: "a".repeat(64),
    });
  m.hosted = false;
  m.credits.mockResolvedValue({ id: "synthetic", monthlyRemaining: 1000 });
  m.spendBoundVerified = true;
  m.enabled = false;
  m.dryRun = true;
  m.gate.mockResolvedValue({
    fingerprint: "a".repeat(64),
    project: {
      organizationId: "synthetic",
      locationCode: 2124,
      languageCode: "en",
    },
    config: { brand: "Example" },
    questions: Array.from({ length: 15 }, (_, i) => ({
      promptId: `question-${i}`,
      prompt: `Synthetic question ${i}?`,
    })),
    estimate: { answers: 60, credits: 92.16, rawCredits: 72 },
  });
  m.post.mockImplementation(async (input: { tasks: { id: string }[] }) => ({
    credits: input.tasks.length * 1.536,
    tasks: input.tasks.map((t: { id: string }) => ({
      id: crypto.randomUUID(),
      status_code: 20100,
      cost: 0.0012,
      data: { tag: t.id },
    })),
  }));
  m.get.mockResolvedValue({
    status_code: 20000,
    result: [
      {
        markdown: "Example is named.",
        items: [{ type: "ai_overview", markdown: "Example is named." }],
      },
    ],
  });
});
it("does no work while OFF", async () => {
  await runMeasurementV2Tick();
  expect(m.gate).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it("dry-run posts nothing and consumes no budget", async () => {
  m.enabled = true;
  await runMeasurementV2Tick();
  expect(m.post).not.toHaveBeenCalled();
  expect(await db.select().from(measurementBudgets)).toHaveLength(0);
});
it("self-hosted with zero customer credits still caps 300 answers and 460.8 billed credits", async () => {
  m.enabled = true;
  m.dryRun = false;
  const now = new Date();
  await runMeasurementV2Tick(now);
  expect(m.post).toHaveBeenCalledTimes(10);
  expect(m.credits).not.toHaveBeenCalled();
  expect(await db.select().from(measurementAnswers)).toHaveLength(300);
  expect((await db.select().from(measurementBudgets))[0]).toMatchObject({
    answers: 300,
    billedCreditHundredths: 46080,
  });
  await runMeasurementV2Tick(new Date(now.getTime() + 300000));
  expect(m.get).toHaveBeenCalledTimes(20);
  expect(m.post).toHaveBeenCalledTimes(10);
});
it("uncertain posts are never replayed and planned answers remain excluded", async () => {
  m.enabled = true;
  m.dryRun = false;
  m.post.mockRejectedValue(new Error("Synthetic uncertainty"));
  await runMeasurementV2Tick();
  await runMeasurementV2Tick();
  expect(m.post).toHaveBeenCalledTimes(5);
  const rows = await db.select().from(measurementAnswers);
  expect(rows).toHaveLength(300);
  expect(
    rows.every(
      (r) => r.status === "error" && r.named === null && r.cited === null,
    ),
  ).toBe(true);
});
it("self-hosted zero-credit bypass cannot exceed 540 billed credits", async () => {
  m.enabled = true;
  m.dryRun = false;
  await db
    .insert(measurementBudgets)
    .values({ week: weekStart(new Date()), billedCreditHundredths: 54000 });
  await runMeasurementV2Tick();
  expect(m.post).not.toHaveBeenCalled();
  expect(m.credits).not.toHaveBeenCalled();
});
it("repeat answers two and three use distinct upstream tasks and never read the prompt cache", async () => {
  m.enabled = true;
  m.dryRun = false;
  const now = new Date();
  await runMeasurementV2Tick(now);
  const first = m.post.mock.calls[0][0];
  const repeats = first.tasks.filter((t) => t.prompt === first.tasks[0].prompt);
  expect(repeats).toHaveLength(3);
  expect(new Set(repeats.map((t) => t.id)).size).toBe(3);
  m.get.mockImplementation(async () => ({
    status_code: 20000,
    result: [
      {
        markdown:
          m.get.mock.calls.length % 3 === 1 ? "Example named" : "Other named",
      },
    ],
  }));
  await runMeasurementV2Tick(new Date(now.getTime() + 300000));
  const completed = (await db.select().from(measurementAnswers)).filter(
    (r) => r.status === "completed",
  );
  expect(completed.some((r) => r.named === true)).toBe(true);
  expect(completed.some((r) => r.named === false)).toBe(true);
  expect(m.cache).not.toHaveBeenCalled();
});
it("refuses posting until a provider maximum-charge bound is verified", async () => {
  m.enabled = true;
  m.dryRun = false;
  m.spendBoundVerified = false;
  await runMeasurementV2Tick();
  expect(m.post).not.toHaveBeenCalled();
  expect(await db.select().from(measurementBudgets)).toHaveLength(0);
});
it("retains paid task IDs when accounting halts an over-budget submission", async () => {
  m.enabled = true;
  m.dryRun = false;
  m.post.mockImplementation(async (input) => ({
    credits: 109,
    tasks: input.tasks.map((t) => ({
      id: crypto.randomUUID(),
      status_code: 20100,
      cost: 0.0012,
      data: { tag: t.id },
    })),
  }));
  const now = new Date();
  await runMeasurementV2Tick(now);
  const paid = (await db.select().from(measurementAnswers)).filter(
    (r) => r.status === "posted",
  );
  expect(paid).toHaveLength(45);
  expect(paid.every((r) => r.taskId)).toBe(true);
  expect(m.post).toHaveBeenCalledTimes(1);
  await runMeasurementV2Tick(new Date(now.getTime() + 300000));
  expect(m.get).toHaveBeenCalledTimes(20);
  expect(m.post).toHaveBeenCalledTimes(1);
});
it("collects paid tasks from their run snapshot after eligibility changes", async () => {
  m.enabled = true;
  m.dryRun = false;
  const now = new Date();
  await runMeasurementV2Tick(now);
  await db.run(
    sql`UPDATE measurement_enrollments SET context_hash = 'invalid'`,
  );
  m.gate.mockRejectedValue(new Error("Context changed"));
  await runMeasurementV2Tick(new Date(now.getTime() + 300000));
  expect(m.get).toHaveBeenCalledTimes(20);
  expect(
    (await db.select().from(measurementAnswers)).filter(
      (r) => r.status === "completed",
    ),
  ).toHaveLength(20);
});

it("preserves paid task IDs even when hosted billing tracking fails", async () => {
  m.enabled = true;
  m.dryRun = false;
  m.hosted = true;
  m.credits.mockImplementation(async (input: unknown) => {
    if (input && typeof input === "object" && "costUsd" in input)
      throw new Error("Synthetic tracking failure");
    return { id: "synthetic", monthlyRemaining: 1000 };
  });
  const now = new Date();
  await runMeasurementV2Tick(now);
  const paid = (await db.select().from(measurementAnswers)).filter(
    (r) => r.status === "posted",
  );
  expect(paid).toHaveLength(225);
  expect(paid.every((r) => r.taskId)).toBe(true);
  await runMeasurementV2Tick(new Date(now.getTime() + 300000));
  expect(m.get).toHaveBeenCalledTimes(20);
  expect(m.post).toHaveBeenCalledTimes(5);
});

it("records malformed task_get responses as unparsed rather than a zero or timeout", async () => {
  m.enabled = true;
  m.dryRun = false;
  const now = new Date();
  await runMeasurementV2Tick(now);
  m.get.mockRejectedValue(new z.ZodError([]));
  await runMeasurementV2Tick(new Date(now.getTime() + 300000));
  const rows = await db.select().from(measurementAnswers);
  expect(rows.filter((r) => r.status === "unparsed")).toHaveLength(20);
  expect(
    rows
      .filter((r) => r.status === "unparsed")
      .every((r) => r.named === null && r.cited === null),
  ).toBe(true);
});
