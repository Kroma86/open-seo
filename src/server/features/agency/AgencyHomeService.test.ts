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
import type * as AgencyHomeServiceModule from "./AgencyHomeService";

// Real in-memory SQLite so org scoping + status filters run against SQL.
// Dynamic import after vi.doMock so the service binds to testDb.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: {
    getPerformance: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getLatestSnapshotsForKeywords: vi.fn().mockResolvedValue([]),
    },
  }),
);

let client: Client;
let getAgencyHomeMissions: typeof AgencyHomeServiceModule.getAgencyHomeMissions;
let getAgencyHomePortfolio: typeof AgencyHomeServiceModule.getAgencyHomePortfolio;

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
    CREATE TABLE gsc_connections (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      organization_id TEXT NOT NULL,
      site_url TEXT NOT NULL,
      connected_by_user_id TEXT NOT NULL,
      gsc_account_id TEXT,
      connected_account_email TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE rank_tracking_configs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      location_code INTEGER NOT NULL DEFAULT 2840,
      language_code TEXT NOT NULL DEFAULT 'en',
      devices TEXT NOT NULL DEFAULT 'both',
      serp_depth INTEGER NOT NULL DEFAULT 20,
      schedule_interval TEXT NOT NULL DEFAULT 'weekly',
      location_name TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      next_check_at TEXT,
      last_skip_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE rank_tracking_keywords (
      id TEXT PRIMARY KEY,
      config_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      search_volume INTEGER,
      keyword_difficulty INTEGER,
      cpc REAL,
      metrics_fetched_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

  ({ getAgencyHomeMissions, getAgencyHomePortfolio } =
    await import("./AgencyHomeService"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM sam_loop_runs;
    DELETE FROM sam_loops;
    DELETE FROM rank_tracking_keywords;
    DELETE FROM rank_tracking_configs;
    DELETE FROM gsc_connections;
    DELETE FROM projects;
  `);
});

async function seedProject(input: {
  id: string;
  org: string;
  name: string;
  domain?: string | null;
  archivedAt?: string | null;
}) {
  await client.execute({
    sql: `INSERT INTO projects
      (id, organization_id, name, domain, archived_at)
      VALUES (?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.org,
      input.name,
      input.domain ?? null,
      input.archivedAt ?? null,
    ],
  });
}

async function seedLoop(input: {
  id: string;
  projectId: string;
  name: string;
  enabled?: boolean;
}) {
  await client.execute({
    sql: `INSERT INTO sam_loops
      (id, project_id, name, source_type, skill_name, cadence, is_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.projectId,
      input.name,
      "skill",
      "site-health",
      "weekly",
      input.enabled === false ? 0 : 1,
    ],
  });
}

async function seedRun(input: {
  id: string;
  loopId: string;
  projectId: string;
  status: string;
  finishedAt?: string | null;
  startedAt?: string | null;
  createdAt?: string;
  costNote?: string | null;
}) {
  await client.execute({
    sql: `INSERT INTO sam_loop_runs
      (id, loop_id, project_id, status, started_at, finished_at, cost_note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.loopId,
      input.projectId,
      input.status,
      input.startedAt ?? "2026-08-30T23:00:00.000Z",
      input.finishedAt ?? null,
      input.costNote ?? null,
      input.createdAt ?? "2026-08-30T23:00:00.000Z",
    ],
  });
}

describe("getAgencyHomeMissions", () => {
  it("scopes runs to the current org only", async () => {
    await seedProject({
      id: "proj_mine",
      org: "org_a",
      name: "Mine",
      domain: "mine.com",
    });
    await seedProject({
      id: "proj_other",
      org: "org_b",
      name: "Other",
      domain: "other.com",
    });
    await seedLoop({ id: "loop_mine", projectId: "proj_mine", name: "Health" });
    await seedLoop({
      id: "loop_other",
      projectId: "proj_other",
      name: "Health",
    });
    await seedRun({
      id: "run_mine",
      loopId: "loop_mine",
      projectId: "proj_mine",
      status: "completed",
      finishedAt: "2026-08-31T01:00:00.000Z",
    });
    await seedRun({
      id: "run_other",
      loopId: "loop_other",
      projectId: "proj_other",
      status: "completed",
      finishedAt: "2026-08-31T02:00:00.000Z",
    });

    const runs = await getAgencyHomeMissions("org_a");
    expect(runs.map((r) => r.id)).toEqual(["run_mine"]);
    expect(runs[0]).toMatchObject({
      loopName: "Health",
      projectDomain: "mine.com",
      status: "completed",
    });
  });

  it("includes running runs and excludes pending", async () => {
    await seedProject({ id: "proj_1", org: "org_a", name: "A" });
    await seedLoop({ id: "loop_1", projectId: "proj_1", name: "Gap" });
    await seedRun({
      id: "run_done",
      loopId: "loop_1",
      projectId: "proj_1",
      status: "completed",
      finishedAt: "2026-08-31T01:00:00.000Z",
    });
    await seedRun({
      id: "run_running",
      loopId: "loop_1",
      projectId: "proj_1",
      status: "running",
      finishedAt: null,
      startedAt: "2026-08-31T03:00:00.000Z",
    });
    await seedRun({
      id: "run_pending",
      loopId: "loop_1",
      projectId: "proj_1",
      status: "pending",
      finishedAt: null,
      startedAt: "2026-08-31T04:00:00.000Z",
    });

    const runs = await getAgencyHomeMissions("org_a");
    expect(runs.map((r) => r.id)).toEqual(["run_running", "run_done"]);
  });

  it("excludes archived projects", async () => {
    await seedProject({
      id: "proj_live",
      org: "org_a",
      name: "Live",
      domain: "live.com",
    });
    await seedProject({
      id: "proj_arch",
      org: "org_a",
      name: "Archived",
      domain: "old.com",
      archivedAt: "2026-08-01T00:00:00.000Z",
    });
    await seedLoop({ id: "loop_live", projectId: "proj_live", name: "L" });
    await seedLoop({ id: "loop_arch", projectId: "proj_arch", name: "A" });
    await seedRun({
      id: "run_live",
      loopId: "loop_live",
      projectId: "proj_live",
      status: "completed",
      finishedAt: "2026-08-31T01:00:00.000Z",
    });
    await seedRun({
      id: "run_arch",
      loopId: "loop_arch",
      projectId: "proj_arch",
      status: "completed",
      finishedAt: "2026-08-31T02:00:00.000Z",
    });

    const runs = await getAgencyHomeMissions("org_a");
    expect(runs.map((r) => r.id)).toEqual(["run_live"]);
  });

  it("limits to 12 by default", async () => {
    await seedProject({ id: "proj_1", org: "org_a", name: "A" });
    await seedLoop({ id: "loop_1", projectId: "proj_1", name: "L" });
    for (let i = 0; i < 15; i += 1) {
      await seedRun({
        id: `run_${i}`,
        loopId: "loop_1",
        projectId: "proj_1",
        status: "completed",
        finishedAt: `2026-08-31T${String(i).padStart(2, "0")}:00:00.000Z`,
      });
    }

    const runs = await getAgencyHomeMissions("org_a");
    expect(runs).toHaveLength(12);
  });
});

describe("getAgencyHomePortfolio", () => {
  it("scopes projects to the current org and marks GSC honestly", async () => {
    await seedProject({
      id: "proj_a",
      org: "org_a",
      name: "Alpha",
      domain: "alpha.com",
    });
    await seedProject({
      id: "proj_b",
      org: "org_b",
      name: "Beta",
      domain: "beta.com",
    });
    await client.execute({
      sql: `INSERT INTO gsc_connections
        (id, project_id, organization_id, site_url, connected_by_user_id)
        VALUES (?, ?, ?, ?, ?)`,
      args: ["gsc_1", "proj_a", "org_a", "sc-domain:alpha.com", "user_1"],
    });

    const rows = await getAgencyHomePortfolio("org_a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: "proj_a",
      domain: "alpha.com",
      gscConnected: true,
      // Empty GSC response → not measured (null), not a fake 0.
      gscClicks28d: null,
      gscImpressions28d: null,
      trackedKeywords: null,
      loopsActive: null,
      setup: { gsc: true, loops: false },
    });
  });

  it("reports loopsActive null when no loops exist, 0 when all disabled", async () => {
    await seedProject({ id: "proj_none", org: "org_a", name: "None" });
    await seedProject({ id: "proj_off", org: "org_a", name: "Off" });
    await seedLoop({
      id: "loop_off",
      projectId: "proj_off",
      name: "Off loop",
      enabled: false,
    });

    const rows = await getAgencyHomePortfolio("org_a");
    const byId = Object.fromEntries(rows.map((r) => [r.projectId, r]));
    expect(byId.proj_none.loopsActive).toBeNull();
    expect(byId.proj_off.loopsActive).toBe(0);
    expect(byId.proj_off.setup.loops).toBe(false);
  });
});
