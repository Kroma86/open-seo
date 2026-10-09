import { article, saved, source } from "../services/monthlyContent.fixture";
import {
  hasVerifiedMonthlyDraft,
  validateMonthlyContent,
} from "../services/monthlyContentResult";
import {
  DEFAULT_SAM_LOOP_TEMPLATES,
  isSamContentLoop,
} from "@/shared/sam-loops";
import type { Client } from "@libsql/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as SamLoopRepositoryModule from "./SamLoopRepository";
import {
  clearSamLoopsTestDb,
  insertLoop as insertLoopRow,
  insertRun as insertRunRow,
  openSamLoopsTestDb,
  seedProject as seedProjectRow,
} from "./SamLoopRepository.query.fixture";

// Run admission and velocity queries against real in-memory SQLite (see
// SamLoopRepository.query.fixture.ts).

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let SamLoopRepository: typeof SamLoopRepositoryModule.SamLoopRepository;

beforeAll(async () => {
  ({ client, SamLoopRepository } = await openSamLoopsTestDb());
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await clearSamLoopsTestDb(client);
});

const seedProject = () => seedProjectRow(client);
const insertLoop = (input: Parameters<typeof insertLoopRow>[1]) =>
  insertLoopRow(client, input);
const insertRun = (input: Parameters<typeof insertRunRow>[1]) =>
  insertRunRow(client, input);

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
        args: [id, createdAt],
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
    )!.customPrompt;
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
