import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: null as unknown, provider: "d1" }));
vi.mock("@/db", () => ({
  get db() {
    return mocks.db;
  },
}));
vi.mock("@/db/d1/client", () => ({
  get d1Db() {
    return mocks.db;
  },
}));
vi.mock("@/db/provider", () => ({ getDatabaseProvider: () => mocks.provider }));
vi.mock("@/db/pg/client", () => ({ pgDb: {} }));
import { SamLoopRepository } from "./SamLoopRepository";

let database: DatabaseSync;
let rejectUpdate = false;
const scheduledFor = "2026-10-01T00:00:00.000Z";
const nextRunAt = "2026-10-08T00:00:00.000Z";
const startedAt = "2026-10-01T12:00:00.000Z";
const input = {
  id: "run-one",
  loopId: "loop-one",
  projectId: "project-one",
  scheduledFor,
  nextRunAt,
  startedAt,
  costNote: "subscription:fixture",
  domain: "niceseo.ai",
  loopsEnabled: false,
};
const admission = { sinceDate: scheduledFor, cap: 1 };

class Prepared {
  constructor(
    readonly query: string,
    readonly parameters: unknown[] = [],
  ) {}
  bind(...parameters: unknown[]) {
    return new Prepared(this.query, parameters);
  }
  async all() {
    return this.result();
  }
  async raw() {
    const statement = database.prepare(this.query);
    statement.setReturnArrays(true);
    return statement.all(...(this.parameters as never[]));
  }
  async run() {
    return this.result();
  }
  result() {
    if (rejectUpdate && this.query.startsWith("update"))
      throw new Error("fixture update failure");
    const statement = database.prepare(this.query);
    const results = statement.columns().length
      ? statement.all(...(this.parameters as never[]))
      : (statement.run(...(this.parameters as never[])), []);
    return { results, success: true, meta: {} };
  }
}

beforeEach(() => {
  rejectUpdate = false;
  database = new DatabaseSync(":memory:");
  database.exec(`
    create table projects (id text primary key, domain text, archived_at text, loops_enabled integer);
    create table sam_loops (id text primary key, project_id text, is_enabled integer, next_run_at text, last_run_at text);
    create table sam_loop_runs (id text primary key, loop_id text, project_id text, status text,
      started_at text, finished_at text, report text, proposals_queued integer default 0,
      steps_used integer, cost_note text, error text, created_at text default current_timestamp);
    create unique index one_active on sam_loop_runs(loop_id) where status in ('pending','running');
    insert into projects values ('project-one', 'niceseo.ai', null, 0);
    insert into sam_loops values ('loop-one', 'project-one', 1, '${scheduledFor}', null);
  `);
  const binding = {
    prepare: (query: string) => new Prepared(query),
    batch: async (statements: Prepared[]) => {
      database.exec("begin immediate");
      try {
        const results = statements.map((statement) => statement.result());
        database.exec("commit");
        return results;
      } catch (error) {
        database.exec("rollback");
        throw error;
      }
    },
  };
  mocks.db = drizzle(binding as unknown as D1Database);
});

afterEach(() => database.close());

it("atomically commits a terminal result and stamps its loop once", async () => {
  await SamLoopRepository.claimSubscriptionRun(input, admission);
  const finishedAt = "2026-10-01T12:05:00.000Z";
  const data = {
    status: "completed" as const,
    finishedAt,
    costNote: "subscription; fixture",
    report: "fixture",
  };
  const identity = {
    loopId: input.loopId,
    projectId: input.projectId,
    finishedAt,
  };
  expect(
    await SamLoopRepository.compareAndSwapSubscriptionRun(
      input.id,
      input.costNote,
      data,
      identity,
    ),
  ).toBe(true);
  expect(
    database.prepare("select last_run_at from sam_loops").get(),
  ).toMatchObject({ last_run_at: finishedAt });
  expect(
    await SamLoopRepository.compareAndSwapSubscriptionRun(
      input.id,
      input.costNote,
      data,
      identity,
    ),
  ).toBe(false);
  expect(
    database.prepare("select status from sam_loop_runs").get(),
  ).toMatchObject({ status: "completed" });
});

it.each(["raise(abort, 'fixture stamp failed')", "raise(ignore)"])(
  "rolls back a terminal result when the loop stamp fails: %s",
  async (failure) => {
    await SamLoopRepository.claimSubscriptionRun(input, admission);
    database.exec(
      `create trigger reject_stamp before update of last_run_at on sam_loops begin select ${failure}; end;`,
    );
    const finishedAt = "2026-10-01T12:05:00.000Z";
    await expect(
      SamLoopRepository.compareAndSwapSubscriptionRun(
        input.id,
        input.costNote,
        {
          status: "completed",
          finishedAt,
          costNote: "subscription; fixture",
          report: "fixture",
        },
        { loopId: input.loopId, projectId: input.projectId, finishedAt },
      ),
    ).rejects.toThrow();
    expect(
      database.prepare("select status, cost_note from sam_loop_runs").get(),
    ).toMatchObject({ status: "running", cost_note: input.costNote });
    expect(
      database.prepare("select last_run_at from sam_loops").get(),
    ).toMatchObject({ last_run_at: null });
  },
);

it("atomically initializes the run and advances only its observed schedule", async () => {
  expect(await SamLoopRepository.claimSubscriptionRun(input, admission)).toBe(
    true,
  );
  expect(
    database.prepare("select next_run_at from sam_loops").get(),
  ).toMatchObject({ next_run_at: nextRunAt });
  expect(await SamLoopRepository.getRunById(input.id)).toMatchObject({
    status: "running",
    costNote: "subscription:fixture",
    createdAt: startedAt,
    report: null,
  });
  expect(
    await SamLoopRepository.claimSubscriptionRun(
      { ...input, id: "run-two" },
      admission,
    ),
  ).toBe(false);
});

it("a full daily cap, including SQLite default dates, cannot consume the schedule", async () => {
  database.exec(
    "insert into sam_loop_runs(id,loop_id,project_id,status,created_at) values ('old','other','project-one','failed','2026-10-01 01:00:00')",
  );
  expect(await SamLoopRepository.claimSubscriptionRun(input, admission)).toBe(
    false,
  );
  expect(
    database.prepare("select next_run_at from sam_loops").get(),
  ).toMatchObject({ next_run_at: scheduledFor });
  expect(await SamLoopRepository.getRunById(input.id)).toBeNull();
});

it("permission changes refuse admission without changing the schedule", async () => {
  database.exec("update projects set loops_enabled = 1");
  expect(await SamLoopRepository.claimSubscriptionRun(input, admission)).toBe(
    false,
  );
  expect(
    database.prepare("select next_run_at from sam_loops").get(),
  ).toMatchObject({ next_run_at: scheduledFor });
});

it("a conflicting run id cannot advance its schedule", async () => {
  database.exec(
    "insert into sam_loop_runs(id,loop_id,project_id,status,created_at) values ('run-one','other','project-one','completed','2026-09-30T00:00:00.000Z')",
  );
  expect(await SamLoopRepository.claimSubscriptionRun(input, admission)).toBe(
    false,
  );
  expect(
    database.prepare("select next_run_at from sam_loops").get(),
  ).toMatchObject({ next_run_at: scheduledFor });
});

it("a previously admitted ISO timestamp consumes the daily cap", async () => {
  expect(await SamLoopRepository.claimSubscriptionRun(input, admission)).toBe(
    true,
  );
  database.exec(
    `update sam_loop_runs set status = 'completed'; insert into sam_loops values ('loop-two', 'project-one', 1, '${scheduledFor}', null);`,
  );
  expect(
    await SamLoopRepository.claimSubscriptionRun(
      { ...input, id: "run-two", loopId: "loop-two" },
      admission,
    ),
  ).toBe(false);
  expect(
    database
      .prepare("select next_run_at from sam_loops where id='loop-two'")
      .get(),
  ).toMatchObject({ next_run_at: scheduledFor });
});

it("a suppressed schedule update rolls back the inserted run", async () => {
  database.exec(
    "create trigger suppress_schedule before update on sam_loops begin select raise(ignore); end;",
  );
  await expect(
    SamLoopRepository.claimSubscriptionRun(input, admission),
  ).rejects.toThrow();
  expect(await SamLoopRepository.getRunById(input.id)).toBeNull();
  expect(
    database.prepare("select next_run_at from sam_loops").get(),
  ).toMatchObject({ next_run_at: scheduledFor });
});

it("rolls back the run insert when schedule advancement fails", async () => {
  rejectUpdate = true;
  await expect(
    SamLoopRepository.claimSubscriptionRun(input, admission),
  ).rejects.toThrow();
  expect(await SamLoopRepository.getRunById(input.id)).toBeNull();
  expect(
    database.prepare("select next_run_at from sam_loops").get(),
  ).toMatchObject({ next_run_at: scheduledFor });
});
