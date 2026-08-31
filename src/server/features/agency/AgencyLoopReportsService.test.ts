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
import type * as AgencyLoopReportsServiceModule from "./AgencyLoopReportsService";

// Real in-memory SQLite so status/finishedAt filters, inclusive since, joins,
// and limit clamping run against actual SQL — the parts a mocked db can't see.
// Dynamic import after vi.doMock is required so the service binds to testDb.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let getAgencyLoopReports: typeof AgencyLoopReportsServiceModule.getAgencyLoopReports;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      domain TEXT,
      location_code INTEGER NOT NULL DEFAULT 2840,
      language_code TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at TEXT
    );
    CREATE TABLE sam_loops (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      skill_name TEXT,
      custom_prompt TEXT,
      cadence TEXT NOT NULL DEFAULT 'weekly',
      is_enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sam_loop_runs (
      id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT,
      finished_at TEXT,
      report TEXT,
      proposals_queued INTEGER NOT NULL DEFAULT 0,
      steps_used INTEGER,
      cost_note TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  ({ getAgencyLoopReports } = await import("./AgencyLoopReportsService"));
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

const SINCE = "2026-08-31T00:00:00.000Z";

async function seedBase() {
  await client.execute({
    sql: "INSERT INTO projects (id, organization_id, name, domain) VALUES (?, ?, ?, ?)",
    args: ["proj_1", "org_1", "NiceSEO", "niceseo.ai"],
  });
  await client.execute({
    sql: `INSERT INTO sam_loops
      (id, project_id, name, source_type, skill_name, cadence)
      VALUES (?, ?, ?, ?, ?, ?)`,
    args: ["loop_1", "proj_1", "Weekly audit", "skill", "seo-audit", "weekly"],
  });
}

async function seedRun(input: {
  id: string;
  status: string;
  finishedAt: string | null;
  report?: string | null;
  error?: string | null;
  startedAt?: string | null;
}) {
  await client.execute({
    sql: `INSERT INTO sam_loop_runs
      (id, loop_id, project_id, status, started_at, finished_at, report, proposals_queued, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      "loop_1",
      "proj_1",
      input.status,
      input.startedAt ?? "2026-08-30T23:00:00.000Z",
      input.finishedAt,
      input.report ?? null,
      0,
      input.error ?? null,
    ],
  });
}

describe("getAgencyLoopReports", () => {
  it("filters out pending and running rows", async () => {
    await seedBase();
    await seedRun({
      id: "run_done",
      status: "completed",
      finishedAt: "2026-08-31T01:00:00.000Z",
      report: "ok",
    });
    await seedRun({
      id: "run_pending",
      status: "pending",
      finishedAt: "2026-08-31T02:00:00.000Z",
    });
    await seedRun({
      id: "run_running",
      status: "running",
      finishedAt: "2026-08-31T03:00:00.000Z",
    });

    const data = await getAgencyLoopReports(SINCE);
    expect(data.runs.map((r) => r.id)).toEqual(["run_done"]);
    expect(data.count).toBe(1);
  });

  it("includes a row whose finishedAt equals since (inclusive cursor)", async () => {
    await seedBase();
    await seedRun({
      id: "run_exact",
      status: "completed",
      finishedAt: SINCE,
      report: "boundary",
    });
    await seedRun({
      id: "run_before",
      status: "completed",
      finishedAt: "2026-08-30T23:59:59.000Z",
      report: "too early",
    });

    const data = await getAgencyLoopReports(SINCE);
    expect(data.runs.map((r) => r.id)).toEqual(["run_exact"]);
  });

  it("returns joined loopName and projectDomain", async () => {
    await seedBase();
    await seedRun({
      id: "run_join",
      status: "completed",
      finishedAt: "2026-08-31T04:00:00.000Z",
      report: "joined",
    });

    const data = await getAgencyLoopReports(SINCE);
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0]).toMatchObject({
      loopName: "Weekly audit",
      cadence: "weekly",
      projectName: "NiceSEO",
      projectDomain: "niceseo.ai",
    });
  });

  it("clamps limit to 200", async () => {
    await seedBase();
    for (let i = 0; i < 201; i += 1) {
      const hour = String(Math.floor(i / 60)).padStart(2, "0");
      const minute = String(i % 60).padStart(2, "0");
      await seedRun({
        id: `run_${i}`,
        status: "completed",
        finishedAt: `2026-08-31T${hour}:${minute}:00.000Z`,
      });
    }

    const data = await getAgencyLoopReports(SINCE, 500);
    expect(data.count).toBe(200);
    expect(data.runs).toHaveLength(200);
  });

  it("includes failed runs with their error field", async () => {
    await seedBase();
    await seedRun({
      id: "run_fail",
      status: "failed",
      finishedAt: "2026-08-31T05:00:00.000Z",
      error: "tool timeout",
    });

    const data = await getAgencyLoopReports(SINCE);
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0]).toMatchObject({
      id: "run_fail",
      status: "failed",
      error: "tool timeout",
    });
  });
});
