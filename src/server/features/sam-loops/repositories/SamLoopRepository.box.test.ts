import { createClient, type Client } from "@libsql/client";
import { drizzle as sqliteDrizzle } from "drizzle-orm/libsql";
import { drizzle as pgDrizzle } from "drizzle-orm/pg-proxy";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as RepositoryModule from "./SamLoopRepository";

// Both real dialect builders execute their SQL against SQLite. This exercises
// predicates, RETURNING and ordering without mocking ORM builder chains;
// it is not a live Postgres server integration test.
for (const provider of ["d1", "postgres"] as const) {
  describe.sequential(`box run repository (${provider})`, () => {
    let client: Client;
    let repository: typeof RepositoryModule.SamLoopRepository;
    beforeAll(async () => {
      // Schema and db exports choose their dialect at module evaluation time.
      vi.resetModules();
      client = createClient({ url: "file::memory:" });
      const database =
        provider === "d1"
          ? sqliteDrizzle(client)
          : pgDrizzle(async (query, params) => {
              const result = await client.execute({
                sql: query.replace(/\$\d+/g, "?"),
                args: params,
              });
              return {
                rows: result.rows.map((row) =>
                  result.columns.map((column) => row[column]),
                ),
              };
            });
      vi.doMock("cloudflare:workers", () => ({
        env: { DATABASE_PROVIDER: provider },
      }));
      vi.doMock("@/db", () => ({ db: database }));
      await client.executeMultiple(`CREATE TABLE sam_loop_runs (
        id TEXT PRIMARY KEY, loop_id TEXT NOT NULL, project_id TEXT NOT NULL,
        status TEXT NOT NULL, started_at TEXT, finished_at TEXT, report TEXT,
        proposals_queued INTEGER NOT NULL DEFAULT 0, steps_used INTEGER,
        cost_note TEXT, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );`);
      ({ SamLoopRepository: repository } = await import("./SamLoopRepository"));
    });
    afterAll(() => client.close());
    beforeEach(async () => {
      await client.execute("DELETE FROM sam_loop_runs");
    });

    async function insert(
      id: string,
      status = "running",
      startedAt: string | null = "2026-10-07T12:00:00.000Z",
      costNote: string | null = "box:grok-sub leased",
    ) {
      await client.execute({
        sql: "INSERT INTO sam_loop_runs (id, loop_id, project_id, status, started_at, cost_note, report) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [
          id,
          `loop_${id}`,
          "project",
          status,
          startedAt,
          costNote,
          "original",
        ],
      });
    }
    const terminal = {
      status: "failed" as const,
      error: "expired",
      report: "terminal",
      finishedAt: "2026-10-07T13:00:00.000Z",
      proposalsQueued: 2,
      stepsUsed: null,
      costNote: "box:grok-sub (lease expired)",
    };

    it("writes all terminal columns once and preserves the first winner", async () => {
      await insert("run");
      expect(await repository.finishRunIfRunning("run", terminal)).toBe(true);
      expect(
        await repository.finishRunIfRunning("run", {
          ...terminal,
          status: "completed",
          report: "late",
        }),
      ).toBe(false);
      expect(await repository.getRunById("run")).toMatchObject(terminal);
    });
    it("does not finalize missing, pending or already terminal runs", async () => {
      for (const status of ["pending", "completed", "failed"]) {
        await insert(status, status);
        expect(await repository.finishRunIfRunning(status, terminal)).toBe(
          false,
        );
        expect(await repository.getRunById(status)).toMatchObject({
          status,
          report: "original",
        });
      }
      expect(await repository.finishRunIfRunning("missing", terminal)).toBe(
        false,
      );
    });
    it("selects only expired running box leases, including the exact boundary", async () => {
      await insert("boundary", "running", "2026-10-07T12:45:00.000Z");
      await insert(
        "old",
        "running",
        "2026-10-07T12:44:59.999Z",
        "box:grok-sub grok-4.6",
      );
      await insert("live", "running", "2026-10-07T12:45:00.001Z");
      await insert(
        "workflow",
        "running",
        "2026-10-07T12:00:00.000Z",
        "OpenRouter",
      );
      await insert(
        "embedded",
        "running",
        "2026-10-07T12:00:00.000Z",
        "other box:grok-sub",
      );
      await insert("null_cost", "running", "2026-10-07T12:00:00.000Z", null);
      await insert("null_start", "running", null);
      for (const status of ["pending", "completed", "failed"])
        await insert(status, status);
      expect(
        await repository.getExpiredBoxRuns("2026-10-07T13:00:00.000Z", 900),
      ).toEqual([
        {
          id: "null_start",
          loopId: "loop_null_start",
          projectId: "project",
          startedAt: null,
        },
        {
          id: "old",
          loopId: "loop_old",
          projectId: "project",
          startedAt: "2026-10-07T12:44:59.999Z",
        },
        {
          id: "boundary",
          loopId: "loop_boundary",
          projectId: "project",
          startedAt: "2026-10-07T12:45:00.000Z",
        },
      ]);
    });
    it("expires only running box rows with a missing lease start", async () => {
      await insert("box_null", "running", null);
      await insert("workflow_null", "running", null, "OpenRouter");
      await insert("unmarked_null", "running", null, null);
      for (const status of ["pending", "completed", "failed"])
        await insert(status, status, null);
      expect(
        await repository.getExpiredBoxRuns("2026-10-07T13:00:00.000Z", 900),
      ).toEqual([
        {
          id: "box_null",
          loopId: "loop_box_null",
          projectId: "project",
          startedAt: null,
        },
      ]);
    });
    it("limits each sweep to the oldest 50 leases and uses the supplied lease duration", async () => {
      for (let index = 50; index >= 0; index--)
        await insert(
          String(index),
          "running",
          new Date(
            Date.parse("2026-10-07T12:00:00.000Z") + index * 1000,
          ).toISOString(),
        );
      const rows = await repository.getExpiredBoxRuns(
        "2026-10-07T12:01:00.000Z",
        10,
      );
      expect(rows.map((row) => row.id)).toEqual(
        Array.from({ length: 50 }, (_, index) => String(index)),
      );
      expect(
        await repository.getExpiredBoxRuns("2026-10-07T12:01:00.000Z", 61),
      ).toEqual([]);
    });
  });
}
