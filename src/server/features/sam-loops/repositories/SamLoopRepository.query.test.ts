import { article, saved, source } from "../services/monthlyContent.fixture";
import {
  hasVerifiedMonthlyDraft,
  validateMonthlyContent,
} from "../services/monthlyContentResult";
import { isSamContentLoop } from "@/shared/sam-loops";
import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import type * as SamLoopRepositoryModule from "./SamLoopRepository";

// Real in-memory SQLite so ensureDefaultLoops idempotence runs against the
// (project_id, name) unique index — the mocked service seed test can't see it.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let SamLoopRepository: typeof SamLoopRepositoryModule.SamLoopRepository;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  // testDb only exists at runtime, so the module under test must load after
  // the mock is registered (vi.doMock is not hoisted).
  vi.doMock("@/db", () => ({ db: testDb }));

  // Stub projects for the FK; pull sam_loops DDL from the real migration so
  // the unique index can't drift from production.
  const migration = readFileSync("drizzle/0043_sweet_tenebrous.sql", "utf8");
  const samLoopsDdl = migration
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.includes("CREATE TABLE `sam_loops`") ||
        s.includes("CREATE TABLE `sam_loop_runs`") ||
        s.includes("CREATE INDEX `sam_loops_") ||
        s.includes("CREATE UNIQUE INDEX `sam_loops_") ||
        s.includes("CREATE INDEX `sam_loop_runs_") ||
        s.includes("CREATE UNIQUE INDEX `sam_loop_runs_"),
    )
    .join("\n");

  await client.executeMultiple(
    [
      `CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        archived_at TEXT
      );`,
      samLoopsDdl,
    ].join("\n"),
  );

  ({ SamLoopRepository } = await import("./SamLoopRepository"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM sam_loop_runs;
    DELETE FROM sam_loops;
    DELETE FROM projects;
  `);
});

async function seedProject() {
  await client.execute({
    sql: "INSERT INTO projects (id, organization_id, name) VALUES (?, ?, ?)",
    args: ["project_1", "org_1", "Acme"],
  });
}

async function insertLoop(input: {
  id: string;
  name: string;
  skillName?: string | null;
  cadence?: string;
  isEnabled?: number;
}) {
  await client.execute({
    sql: `INSERT INTO sam_loops (
      id, project_id, name, source_type, skill_name, cadence, is_enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      "project_1",
      input.name,
      input.skillName ? "skill" : "custom",
      input.skillName ?? null,
      input.cadence ?? "monthly",
      input.isEnabled ?? 1,
    ],
  });
}

async function insertRun(input: {
  id: string;
  loopId: string;
  status: string;
  finishedAt?: string | null;
  report?: string | null;
}) {
  await client.execute({
    sql: `INSERT INTO sam_loop_runs (
      id, loop_id, project_id, status, finished_at, report
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.loopId,
      "project_1",
      input.status,
      input.finishedAt ?? null,
      input.report ?? null,
    ],
  });
}

describe("ensureDefaultLoops", () => {
  it("second pass inserts nothing against the real unique index", async () => {
    await client.execute({
      sql: "INSERT INTO projects (id, organization_id, name) VALUES (?, ?, ?)",
      args: ["project_1", "org_1", "Acme"],
    });

    const first = await SamLoopRepository.ensureDefaultLoops("project_1");
    expect(first).toHaveLength(DEFAULT_SAM_LOOP_TEMPLATES.length);

    const second = await SamLoopRepository.ensureDefaultLoops("project_1");
    expect(second).toEqual([]);

    const loops = await SamLoopRepository.getLoopsForProject("project_1");
    expect(loops).toHaveLength(DEFAULT_SAM_LOOP_TEMPLATES.length);
  });

  it("spreads the same template to different dates for different projects", async () => {
    await client.execute({
      sql: "INSERT INTO projects (id, organization_id, name) VALUES (?, ?, ?)",
      args: ["project_1", "org_1", "Acme"],
    });
    await client.execute({
      sql: "INSERT INTO projects (id, organization_id, name) VALUES (?, ?, ?)",
      args: ["project_2", "org_1", "Beta"],
    });

    await SamLoopRepository.ensureDefaultLoops("project_1");
    await SamLoopRepository.ensureDefaultLoops("project_2");

    const loops1 = await SamLoopRepository.getLoopsForProject("project_1");
    const loops2 = await SamLoopRepository.getLoopsForProject("project_2");
    const byName = (
      loops: Awaited<ReturnType<typeof SamLoopRepository.getLoopsForProject>>,
      name: string,
    ) => loops.find((loop) => loop.name === name)?.nextRunAt?.slice(0, 10);

    // Assigned days differ by seed: Site health weekly lands Friday for
    // project_1 (hash%7 = 4) vs Tuesday for project_2 (hash%7 = 1); GBP
    // drift monthly lands on month-day 24 vs 9 (1 + hash%28).
    expect(byName(loops1, "Site health")).toBeDefined();
    expect(byName(loops1, "Site health")).not.toBe(
      byName(loops2, "Site health"),
    );
    expect(byName(loops1, "GBP drift")).toBeDefined();
    expect(byName(loops1, "GBP drift")).not.toBe(byName(loops2, "GBP drift"));
  });
});

describe("getContentVelocityForProject", () => {
  const sinceIso = "2026-07-01T00:00:00.000Z";

  beforeEach(async () => {
    await seedProject();
    await insertLoop({
      id: "loop_content",
      name: "Monthly content",
      cadence: "monthly",
    });
    await insertLoop({
      id: "loop_brief",
      name: "Content brief",
      skillName: "content-brief",
      cadence: "weekly",
    });
    await insertLoop({
      id: "loop_rank",
      name: "Rank check",
      skillName: "rank-slippage",
      cadence: "daily",
    });
  });

  it("returns completed runs for content loops with hasDraft", async () => {
    await insertRun({
      id: "run_1",
      loopId: "loop_content",
      status: "completed",
      finishedAt: "2026-08-15T12:00:00.000Z",
      report: "# Draft",
    });
    await insertRun({
      id: "run_2",
      loopId: "loop_brief",
      status: "completed",
      finishedAt: "2026-09-01T08:00:00.000Z",
      report: null,
    });

    const rows = await SamLoopRepository.getContentVelocityForProject(
      "project_1",
      sinceIso,
    );

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          loopId: "loop_content",
          loopName: "Monthly content",
          cadence: "monthly",
          isEnabled: true,
          finishedAt: "2026-08-15T12:00:00.000Z",
          hasDraft: false,
        }),
        expect.objectContaining({
          loopId: "loop_brief",
          hasDraft: false,
        }),
      ]),
    );
  });

  it("excludes non-content loops such as Rank check", async () => {
    await insertRun({
      id: "run_rank",
      loopId: "loop_rank",
      status: "completed",
      finishedAt: "2026-08-01T00:00:00.000Z",
      report: "report",
    });
    await insertRun({
      id: "run_content",
      loopId: "loop_content",
      status: "completed",
      finishedAt: "2026-08-02T00:00:00.000Z",
      report: "draft",
    });

    const rows = await SamLoopRepository.getContentVelocityForProject(
      "project_1",
      sinceIso,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.loopId).toBe("loop_content");
  });

  it("excludes runs before sinceIso and without finishedAt", async () => {
    await insertRun({
      id: "run_old",
      loopId: "loop_content",
      status: "completed",
      finishedAt: "2026-06-30T23:59:59.000Z",
      report: "old",
    });
    await insertRun({
      id: "run_boundary",
      loopId: "loop_content",
      status: "completed",
      finishedAt: sinceIso,
      report: "on boundary",
    });
    await insertRun({
      id: "run_no_finish",
      loopId: "loop_content",
      status: "completed",
      finishedAt: null,
      report: "no finish",
    });

    const rows = await SamLoopRepository.getContentVelocityForProject(
      "project_1",
      sinceIso,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.finishedAt).toBe(sinceIso);
    expect(rows[0]?.hasDraft).toBe(false);
  });

  it("treats empty-string report as completed without draft", async () => {
    await insertRun({
      id: "run_empty_report",
      loopId: "loop_content",
      status: "completed",
      finishedAt: "2026-08-10T00:00:00.000Z",
      report: "",
    });

    const rows = await SamLoopRepository.getContentVelocityForProject(
      "project_1",
      sinceIso,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.hasDraft).toBe(false);
  });

  it("excludes failed and running runs", async () => {
    await insertRun({
      id: "run_failed",
      loopId: "loop_content",
      status: "failed",
      finishedAt: "2026-08-01T00:00:00.000Z",
      report: null,
    });
    await insertRun({
      id: "run_running",
      loopId: "loop_content",
      status: "running",
      finishedAt: "2026-08-02T00:00:00.000Z",
      report: null,
    });
    await insertRun({
      id: "run_ok",
      loopId: "loop_content",
      status: "completed",
      finishedAt: "2026-08-03T00:00:00.000Z",
      report: "ok",
    });

    const rows = await SamLoopRepository.getContentVelocityForProject(
      "project_1",
      sinceIso,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.finishedAt).toBe("2026-08-03T00:00:00.000Z");
  });
});

describe("countRunsCreatedSince", () => {
  it("counts runs on or after a YYYY-MM-DD prefix, including sqlite timestamps", async () => {
    await seedProject();
    await insertLoop({
      id: "loop_1",
      name: "Site health",
      skillName: "site-health",
    });
    await client.execute({
      sql: `INSERT INTO sam_loop_runs (id, loop_id, project_id, status, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        "run_space",
        "loop_1",
        "project_1",
        "completed",
        "2026-09-01 08:00:00",
      ],
    });
    await client.execute({
      sql: `INSERT INTO sam_loop_runs (id, loop_id, project_id, status, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        "run_iso",
        "loop_1",
        "project_1",
        "completed",
        "2026-09-01T08:00:00.000Z",
      ],
    });
    await client.execute({
      sql: `INSERT INTO sam_loop_runs (id, loop_id, project_id, status, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        "run_old",
        "loop_1",
        "project_1",
        "completed",
        "2026-08-31 23:59:59",
      ],
    });

    await expect(
      SamLoopRepository.countRunsCreatedSince("2026-09-01"),
    ).resolves.toBe(2);
  });
});

describe("atomic daily run admission", () => {
  it("admits only the last slot across concurrent different-loop claims and mixed date formats", async () => {
    await seedProject();
    await insertLoop({ id: "history", name: "History" });
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (const [id, createdAt] of [
      ["earlier_sqlite", `${today} 00:01:00`],
      ["earlier_iso", `${today}T00:02:00.000Z`],
      ["previous_day", `${yesterday}T23:59:59.000Z`],
    ]) {
      await client.execute({
        sql: `INSERT INTO sam_loop_runs
          (id, loop_id, project_id, status, created_at)
          VALUES (?, 'history', 'project_1', 'completed', ?)`,
        args: [id!, createdAt!],
      });
    }
    const loopIds = [
      "candidate_a",
      "candidate_b",
      "candidate_c",
      "candidate_d",
    ];
    for (const id of loopIds) await insertLoop({ id, name: id });

    const admitted = await Promise.all(
      loopIds.map((loopId) =>
        SamLoopRepository.tryCreateRun(
          { id: `run_${loopId}`, loopId, projectId: "project_1" },
          { sinceDate: today, cap: 3 },
        ),
      ),
    );

    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect(await SamLoopRepository.countRunsCreatedSince(today)).toBe(3);
    const pending = await client.execute(
      "SELECT id FROM sam_loop_runs WHERE status = 'pending'",
    );
    expect(pending.rows).toHaveLength(1);
  });

  it("keeps the existing in-flight run when budget exists but its loop is already active", async () => {
    await seedProject();
    await insertLoop({ id: "active_loop", name: "Active loop" });
    await insertRun({
      id: "active_run",
      loopId: "active_loop",
      status: "running",
    });

    await expect(
      SamLoopRepository.tryCreateRun(
        { id: "duplicate_run", loopId: "active_loop", projectId: "project_1" },
        { sinceDate: new Date().toISOString().slice(0, 10), cap: 10 },
      ),
    ).resolves.toBe(false);
    expect(await SamLoopRepository.getRunById("duplicate_run")).toBeNull();
    expect(
      await SamLoopRepository.getActiveRunForLoop("active_loop"),
    ).toMatchObject({
      id: "active_run",
      status: "running",
    });
  });
});

describe("validated article velocity", () => {
  it("counts the complete artifact for a renamed approved monthly identity", async () => {
    await seedProject();
    await insertLoop({ id: "renamed", name: "Editorial routine" });
    const prompt = DEFAULT_SAM_LOOP_TEMPLATES.find(
      (t) => t.name === "Monthly content",
    )!.customPrompt!;
    await client.execute({
      sql: "UPDATE sam_loops SET custom_prompt = ? WHERE id = ?",
      args: [prompt, "renamed"],
    });
    const checked = await validateMonthlyContent(
      article,
      [{ toolResults: [saved, source] }],
      "example.com",
    );
    expect(checked.error).toBeNull();
    await insertRun({
      id: "draft",
      loopId: "renamed",
      status: "completed",
      finishedAt: "2026-09-04T00:00:00Z",
      report: checked.report,
    });
    const rows = await SamLoopRepository.getContentVelocityForProject(
      "project_1",
      "2026-09-01",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hasDraft).toBe(true);
    const stored = await SamLoopRepository.getRunById("draft");
    expect(stored?.report).toBe(checked.report);
    await expect(hasVerifiedMonthlyDraft(stored?.report ?? null)).resolves.toBe(
      true,
    );
    expect(
      isSamContentLoop({
        name: "Editorial routine",
        sourceType: "custom",
        customPrompt: prompt,
        skillName: null,
      }),
    ).toBe(true);
    expect(
      isSamContentLoop({
        name: "Editorial routine",
        sourceType: "custom",
        customPrompt: prompt + "edited",
        skillName: null,
      }),
    ).toBe(false);
  });
});
