import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "@/db";
import { rankCheckRuns, rankTrackingConfigs } from "@/db/schema";
import { RankTrackingRepository } from "../repositories/RankTrackingRepository";
import { beginRankCheckRun } from "./rankCheckRunGuards";
import { reconcileStuckRankCheckRuns } from "./rankCheckReconciler";

const state = await vi.hoisted(async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const client = createClient({ url: "file::memory:" });
  return {
    provider: "d1",
    client,
    testDb: drizzle(client),
    bindings: {} as Record<string, unknown>,
  };
});
vi.mock("cloudflare:workers", () => ({ env: state.bindings }));
vi.mock("@/db/provider", () => ({ getDatabaseProvider: () => state.provider }));
// Actual SQLite executes the production Drizzle queries; no builder-chain mocks.
vi.mock("@/db", () => ({ db: state.testDb }));
vi.mock("@/db/runBatch", () => ({ DB_BATCH_SIZE: 100 }));

const { client } = state;
const NOW = new Date("2026-09-23T06:05:00.000Z");

beforeEach(async () => {
  state.provider = "d1";
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await client.executeMultiple(`
    DROP TABLE IF EXISTS rank_check_runs;
    DROP TABLE IF EXISTS rank_tracking_configs;
    DROP TABLE IF EXISTS rank_snapshots;
    CREATE TABLE rank_check_runs (
      id TEXT PRIMARY KEY, config_id TEXT NOT NULL, project_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', keywords_total INTEGER NOT NULL DEFAULT 2,
      keywords_checked INTEGER NOT NULL DEFAULT 0, is_subset_run INTEGER NOT NULL DEFAULT 0,
      error_message TEXT, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
    );
    CREATE UNIQUE INDEX one_active ON rank_check_runs(config_id) WHERE status IN ('pending','running');
    CREATE TABLE rank_tracking_configs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, domain TEXT NOT NULL,
      location_code INTEGER DEFAULT 2840, language_code TEXT DEFAULT 'en', devices TEXT DEFAULT 'desktop',
      serp_depth INTEGER DEFAULT 20, schedule_interval TEXT DEFAULT 'daily', location_name TEXT,
      is_active INTEGER DEFAULT 1, last_checked_at TEXT, next_check_at TEXT, last_skip_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE rank_snapshots (
      id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, tracking_keyword_id TEXT NOT NULL,
      keyword TEXT NOT NULL, device TEXT NOT NULL, position INTEGER, url TEXT, serp_features TEXT,
      checked_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, tracking_keyword_id, device)
    );
  `);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const name of Object.keys(state.bindings)) delete state.bindings[name];
});
afterAll(() => client.close());

async function seed(
  minutes: number,
  options: {
    id?: string;
    status?: "running" | "pending" | "failed";
    snapshots?: number;
    iso?: boolean;
    startedAt?: string;
  } = {},
) {
  const id = options.id ?? "run_1";
  const iso = new Date(NOW.getTime() - minutes * 60_000).toISOString();
  await db.insert(rankTrackingConfigs).values({
    id,
    projectId: "project_1",
    domain: "example.com",
    serpDepth: 20,
    nextCheckAt: "2026-09-24T06:00:00.000Z",
  });
  await db.insert(rankCheckRuns).values({
    id,
    configId: id,
    projectId: "project_1",
    status: options.status ?? "running",
    keywordsTotal: 2,
    startedAt:
      options.startedAt ??
      (options.iso ? iso : iso.replace("T", " ").slice(0, 19)),
  });
  for (let i = 0; i < (options.snapshots ?? 0); i++) {
    await client.execute({
      sql: "INSERT INTO rank_snapshots(run_id, tracking_keyword_id, keyword, device) VALUES (?, ?, ?, 'desktop')",
      args: [id, `kw_${i}`, `keyword ${i}`],
    });
  }
  return id;
}

async function row(id = "run_1") {
  return RankTrackingRepository.getRunById(id);
}

describe("rank watchdog against stored timestamps", () => {
  it("leaves a one-minute-old D1 run pending even with full snapshots", async () => {
    await seed(1, { status: "pending", snapshots: 2 });
    await reconcileStuckRankCheckRuns();
    expect(await row()).toMatchObject({ status: "pending", completedAt: null });
  });

  it("does not kill a five-minute-old D1 run still collecting results", async () => {
    await seed(5);
    await reconcileStuckRankCheckRuns();
    expect(await row()).toMatchObject({
      status: "running",
      errorMessage: null,
    });
  });

  it.each([25, 26])(
    "enforces the unchanged 25-minute timeout at age %i",
    async (minutes) => {
      await seed(minutes);
      await reconcileStuckRankCheckRuns();
      expect((await row())?.status).toBe(minutes === 25 ? "running" : "failed");
    },
  );

  it("completes fully collected results and remains idempotent on the next sweep", async () => {
    await seed(5, { snapshots: 2 });
    await reconcileStuckRankCheckRuns();
    expect(await row()).toMatchObject({
      status: "completed",
      keywordsChecked: 2,
      completedAt: NOW.toISOString(),
    });
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await reconcileStuckRankCheckRuns();
    expect((await row())?.completedAt).toBe(NOW.toISOString());
    const config = await RankTrackingRepository.getConfigById({
      configId: "run_1",
      projectId: "project_1",
    });
    expect(config).toMatchObject({
      lastCheckedAt: NOW.toISOString(),
      nextCheckAt: "2026-09-24T06:00:00.000Z",
    });
  });

  it("closes a real stale run so the next scheduled start can claim its unique slot", async () => {
    await seed(30);
    await reconcileStuckRankCheckRuns();
    expect(await row()).toMatchObject({
      status: "failed",
      errorMessage: "Rank check timed out before finalizing",
    });
    const create = vi.fn().mockResolvedValue(undefined);
    const result = await beginRankCheckRun({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only workflow creation is mocked; the unique slot is checked by real SQL.
      workflow: { create } as unknown as Env["RANK_CHECK_WORKFLOW"],
      config: {
        id: "run_1",
        domain: "example.com",
        locationCode: 2840,
        languageCode: "en",
        locationName: null,
        devices: "desktop",
        serpDepth: 20,
      },
      projectId: "project_1",
      billingCustomer: {
        userId: "system",
        userEmail: "system@example.com",
        organizationId: "org_1",
      },
      keywordsTotal: 2,
      trigger: "scheduled",
      workflowStartErrorMessage: "failed",
    });
    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("uses the ISO timestamp convention for Postgres", async () => {
    await seed(5, { id: "fresh", iso: true });
    await seed(30, { id: "stale", iso: true });
    state.provider = "postgres";
    await reconcileStuckRankCheckRuns();
    expect((await row("fresh"))?.status).toBe("running");
    expect((await row("stale"))?.status).toBe("failed");
  });

  it("does not treat malformed timestamp text as proof of timeout", async () => {
    await seed(30, { startedAt: "2026-09-22 invalid" });
    const warning = vi.spyOn(console, "warn");
    await reconcileStuckRankCheckRuns();
    expect((await row())?.status).toBe("running");
    expect(warning).toHaveBeenCalledWith(
      "[rank-check] watchdog skipped run_1: invalid startedAt",
    );
  });

  it("closes at most 100 stale runs per sweep and resumes the remainder", async () => {
    for (let i = 0; i < 102; i++) await seed(30, { id: `run_${i}` });
    await reconcileStuckRankCheckRuns();
    const countActive = async () =>
      (
        await client.execute(
          "SELECT COUNT(*) AS n FROM rank_check_runs WHERE status = 'running'",
        )
      ).rows[0].n;
    expect(await countActive()).toBe(2);
    await reconcileStuckRankCheckRuns();
    expect(await countActive()).toBe(0);
  });

  it.each(["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY"])(
    "refuses %s before changing a run",
    async (name) => {
      await seed(30);
      vi.stubEnv(name, "");
      await expect(reconcileStuckRankCheckRuns()).rejects.toThrow(
        "subscriptions only",
      );
      expect((await row())?.status).toBe("running");
    },
  );
});

// Proves the subscription guard also covers Worker bindings, where process.env
// population may be disabled. Empty values still count as configured keys.
it.each(["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY"])(
  "refuses Worker binding %s before database changes",
  async (name) => {
    await seed(30);
    state.bindings[name] = "";
    await expect(reconcileStuckRankCheckRuns()).rejects.toThrow(
      "subscriptions only",
    );
    expect((await row())?.status).toBe("running");
  },
);

it("does not depend on the Node process global in a Worker", async () => {
  await seed(30);
  let caught: unknown;
  vi.stubGlobal("process", undefined);
  try {
    await reconcileStuckRankCheckRuns();
  } catch (error) {
    caught = error;
  } finally {
    vi.unstubAllGlobals();
  }
  expect(caught).toBeUndefined();
  expect((await row())?.status).toBe("failed");
});
