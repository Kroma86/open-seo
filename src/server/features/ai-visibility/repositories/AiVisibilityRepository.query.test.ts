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
import type * as AiVisibilityRepositoryModule from "./AiVisibilityRepository";

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let testDb: ReturnType<typeof drizzle>;
let AiVisibilityRepository: typeof AiVisibilityRepositoryModule.AiVisibilityRepository;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/provider", () => ({
    getDatabaseProvider: () => "d1",
  }));

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
    CREATE TABLE ai_visibility_configs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      brand TEXT NOT NULL,
      competitors TEXT NOT NULL DEFAULT '[]',
      platforms TEXT NOT NULL DEFAULT '["chat_gpt","google"]',
      schedule_interval TEXT NOT NULL DEFAULT 'weekly',
      prompt_set_version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX ai_visibility_configs_project_brand_idx
      ON ai_visibility_configs(project_id, brand);
    CREATE TABLE ai_visibility_prompts (
      id TEXT PRIMARY KEY,
      config_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX ai_visibility_prompts_config_prompt_idx
      ON ai_visibility_prompts(config_id, prompt);
    CREATE TABLE ai_visibility_runs (
      id TEXT PRIMARY KEY,
      config_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      prompt_set_version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT,
      finished_at TEXT,
      total_mentions INTEGER,
      share_of_voice_pct REAL,
      prompts_with_brand INTEGER,
      prompts_checked INTEGER,
      detail TEXT,
      cost_note TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX ai_visibility_runs_one_inflight_idx
      ON ai_visibility_runs(config_id)
      WHERE status IN ('pending', 'running');
  `);

  ({ AiVisibilityRepository } = await import("./AiVisibilityRepository"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM ai_visibility_runs;
    DELETE FROM ai_visibility_prompts;
    DELETE FROM ai_visibility_configs;
    DELETE FROM projects;
  `);
  await client.execute(`
    INSERT INTO projects (id, organization_id, name)
    VALUES ('project_1', 'org_1', 'Example');
  `);
  await client.execute(`
    INSERT INTO ai_visibility_configs (
      id, project_id, brand, schedule_interval, next_run_at, is_active
    ) VALUES (
      'config_1', 'project_1', 'Acme', 'weekly', '2026-01-01T00:00:00.000Z', 1
    );
  `);
});

describe("AiVisibilityRepository queries", () => {
  it("returns due configs excluding manual schedules", async () => {
    await client.execute(`
      INSERT INTO ai_visibility_configs (
        id, project_id, brand, schedule_interval, next_run_at, is_active
      ) VALUES (
        'config_manual', 'project_1', 'ManualCo', 'manual', '2020-01-01T00:00:00.000Z', 1
      );
    `);

    const due = await AiVisibilityRepository.getDueConfigsWithOrganization(
      "2026-02-01T00:00:00.000Z",
    );
    expect(due.map((row) => row.id)).toEqual(["config_1"]);
  });

  it("blocks a second in-flight run for the same config", async () => {
    const first = await AiVisibilityRepository.tryCreateRun({
      id: "run_1",
      configId: "config_1",
      projectId: "project_1",
      promptSetVersion: 1,
    });
    const second = await AiVisibilityRepository.tryCreateRun({
      id: "run_2",
      configId: "config_1",
      projectId: "project_1",
      promptSetVersion: 1,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("claims a due config only when next_run_at matches", async () => {
    const claimed = await AiVisibilityRepository.claimDueConfig({
      configId: "config_1",
      projectId: "project_1",
      observedNextRunAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-08T00:00:00.000Z",
    });
    const lostRace = await AiVisibilityRepository.claimDueConfig({
      configId: "config_1",
      projectId: "project_1",
      observedNextRunAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-15T00:00:00.000Z",
    });

    expect(claimed).toBe(true);
    expect(lostRace).toBe(false);
  });

  it("enforces the active prompt cap after insert under contention", async () => {
    for (let i = 0; i < 9; i++) {
      const result = await AiVisibilityRepository.addPromptRespectingCap({
        id: `prompt_${i}`,
        configId: "config_1",
        prompt: `prompt ${i}`,
      });
      expect(result.ok).toBe(true);
    }

    const tenth = await AiVisibilityRepository.addPromptRespectingCap({
      id: "prompt_a",
      configId: "config_1",
      prompt: "prompt a",
    });
    expect(tenth.ok).toBe(true);

    const eleventh = await AiVisibilityRepository.addPromptRespectingCap({
      id: "prompt_b",
      configId: "config_1",
      prompt: "prompt b",
    });
    expect(eleventh).toEqual({ ok: false, reason: "cap" });

    expect(
      await AiVisibilityRepository.countActivePromptsForConfig("config_1"),
    ).toBe(10);
  });

  it("self-repairs when two adds race at nine active prompts", async () => {
    for (let i = 0; i < 9; i++) {
      const result = await AiVisibilityRepository.addPromptRespectingCap({
        id: `prompt_${String(i).padStart(2, "0")}`,
        configId: "config_1",
        prompt: `race base ${i}`,
      });
      expect(result.ok).toBe(true);
    }

    const [raceFirst, raceSecond] = await Promise.all([
      AiVisibilityRepository.addPromptRespectingCap({
        id: "prompt_09",
        configId: "config_1",
        prompt: "prompt race a",
      }),
      AiVisibilityRepository.addPromptRespectingCap({
        id: "prompt_10",
        configId: "config_1",
        prompt: "prompt race b",
      }),
    ]);
    const outcomes = [raceFirst, raceSecond];
    expect(outcomes.filter((row) => row.ok)).toHaveLength(1);
    expect(outcomes.filter((row) => !row.ok && row.reason === "cap")).toHaveLength(
      1,
    );
    expect(
      await AiVisibilityRepository.countActivePromptsForConfig("config_1"),
    ).toBe(10);
  });

  it("allows a new run after reclaiming a stale in-flight row", async () => {
    const staleStarted = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    await client.execute({
      sql: `
        INSERT INTO ai_visibility_runs (
          id, config_id, project_id, prompt_set_version, status,
          started_at, created_at
        ) VALUES (
          'run_stale', 'config_1', 'project_1', 1, 'running',
          ?, ?
        )
      `,
      args: [staleStarted, staleStarted],
    });

    const { reclaimStaleRunsForConfig } = await import(
      "../services/aiVisibilityReconciler"
    );
    await reclaimStaleRunsForConfig("config_1");

    const created = await AiVisibilityRepository.tryCreateRun({
      id: "run_new",
      configId: "config_1",
      projectId: "project_1",
      promptSetVersion: 1,
    });
    expect(created).toBe(true);
  });

  it("still blocks a new run when a recent in-flight row exists", async () => {
    const recentStarted = new Date(Date.now() - 60_000).toISOString();
    await client.execute({
      sql: `
        INSERT INTO ai_visibility_runs (
          id, config_id, project_id, prompt_set_version, status,
          started_at, created_at
        ) VALUES (
          'run_live', 'config_1', 'project_1', 1, 'running',
          ?, ?
        )
      `,
      args: [recentStarted, recentStarted],
    });

    const { reclaimStaleRunsForConfig } = await import(
      "../services/aiVisibilityReconciler"
    );
    await reclaimStaleRunsForConfig("config_1");

    const created = await AiVisibilityRepository.tryCreateRun({
      id: "run_new",
      configId: "config_1",
      projectId: "project_1",
      promptSetVersion: 1,
    });
    expect(created).toBe(false);
  });

  it("reclaims a same-day stale run when cutoff uses ISO timestamps", async () => {
    const staleStarted = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    await client.execute({
      sql: `
        INSERT INTO ai_visibility_runs (
          id, config_id, project_id, prompt_set_version, status,
          started_at, created_at
        ) VALUES (
          'run_same_day', 'config_1', 'project_1', 1, 'running',
          ?, ?
        )
      `,
      args: [staleStarted, staleStarted],
    });

    const { reconcileStaleAiVisibilityRuns } = await import(
      "../services/aiVisibilityReconciler"
    );
    await reconcileStaleAiVisibilityRuns();

    const row = await client.execute({
      sql: `SELECT status, error FROM ai_visibility_runs WHERE id = 'run_same_day'`,
    });
    expect(row.rows[0]).toMatchObject({
      status: "failed",
      error: "stale run reclaimed",
    });
  });
});
