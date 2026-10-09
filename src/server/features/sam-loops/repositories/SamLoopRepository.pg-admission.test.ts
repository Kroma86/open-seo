import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  directExecute: vi.fn(),
  d1All: vi.fn(),
  update: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "postgres" },
}));
vi.mock("@/db", () => ({ db: { all: mocks.d1All, update: mocks.update } }));
vi.mock("@/db/pg/client", () => ({
  pgDb: { transaction: mocks.transaction, execute: mocks.directExecute },
}));

import { SamLoopRepository } from "./SamLoopRepository";

const candidate = {
  id: "run_candidate",
  loopId: "loop_example",
  projectId: "project_example",
};
const admission = { sinceDate: "2026-09-04", cap: 40 };
type Execute = (query: SQL) => Promise<Array<{ id: string }>>;
type Transaction = { execute: Execute };

describe("Postgres atomic daily admission", () => {
  it.each([true, false])(
    "keeps terminal run and loop stamp in one transaction; stamp succeeds=%s",
    async (stampSucceeds) => {
      const query = sql`update sam_loop_runs set status = 'completed' returning id`;
      const builder = {
        set: vi.fn(),
        where: vi.fn(),
        returning: vi.fn(),
        getSQL: () => query,
      };
      builder.set.mockReturnValue(builder);
      builder.where.mockReturnValue(builder);
      builder.returning.mockReturnValue(builder);
      mocks.update.mockReturnValue(builder);
      const execute = vi
        .fn<Execute>()
        .mockResolvedValueOnce([{ id: candidate.id }])
        .mockResolvedValueOnce(stampSucceeds ? [{ id: candidate.loopId }] : []);
      mocks.transaction.mockImplementation(
        (work: (tx: Transaction) => Promise<boolean>) => work({ execute }),
      );
      const finishedAt = "2026-10-01T12:05:00.000Z";
      const pending = SamLoopRepository.compareAndSwapSubscriptionRun(
        candidate.id,
        "subscription:fixture",
        { status: "completed", finishedAt, costNote: "subscription; fixture" },
        {
          loopId: candidate.loopId,
          projectId: candidate.projectId,
          finishedAt,
        },
      );
      if (stampSucceeds) await expect(pending).resolves.toBe(true);
      else
        await expect(pending).rejects.toThrow(
          "subscription_terminal_loop_not_stamped",
        );
      expect(execute).toHaveBeenCalledTimes(2);
      expect(
        new PgDialect().sqlToQuery(execute.mock.calls[1][0]).sql,
      ).toContain("last_run_at");
      expect(mocks.directExecute).not.toHaveBeenCalled();
    },
  );
  it("claims subscription work under the same lock and initializes provenance before advancing", async () => {
    const execute = vi
      .fn<Execute>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: candidate.id }])
      .mockResolvedValueOnce([{ id: candidate.loopId }]);
    mocks.transaction.mockImplementation(
      (work: (tx: Transaction) => Promise<boolean>) => work({ execute }),
    );
    const input = {
      ...candidate,
      scheduledFor: "2026-10-01T00:00:00.000Z",
      nextRunAt: "2026-10-08T00:00:00.000Z",
      startedAt: "2026-10-01T12:00:00.000Z",
      costNote: "subscription:fixture",
      domain: "niceseo.ai",
      loopsEnabled: false,
    };
    expect(await SamLoopRepository.claimSubscriptionRun(input, admission)).toBe(
      true,
    );
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(execute.mock.calls[0][0]).sql).toBe(
      "select pg_advisory_xact_lock(734629105)",
    );
    const insert = dialect.sqlToQuery(execute.mock.calls[1][0]);
    expect(insert.sql).toContain("cost_note, created_at");
    expect(insert.params).toContain("subscription:fixture");
    expect(insert.params).toContain(false);
    expect(dialect.sqlToQuery(execute.mock.calls[2][0]).sql).toContain(
      'update "sam_loops" set next_run_at',
    );
    expect(mocks.directExecute).not.toHaveBeenCalled();
  });
  it("throws inside the transaction when a subscription schedule update changes no row", async () => {
    const execute = vi
      .fn<Execute>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: candidate.id }])
      .mockResolvedValueOnce([]);
    mocks.transaction.mockImplementation(
      (work: (tx: Transaction) => Promise<boolean>) => work({ execute }),
    );
    await expect(
      SamLoopRepository.claimSubscriptionRun(
        {
          ...candidate,
          scheduledFor: "2026-10-01T00:00:00.000Z",
          nextRunAt: "2026-10-08T00:00:00.000Z",
          startedAt: "2026-10-01T12:00:00.000Z",
          costNote: "subscription:fixture",
          domain: "niceseo.ai",
          loopsEnabled: false,
        },
        admission,
      ),
    ).rejects.toThrow("subscription_schedule_not_advanced");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(mocks.directExecute).not.toHaveBeenCalled();
  });
  it("awaits the shared transaction lock before inserting on the same transaction handle", async () => {
    let releaseLock!: () => void;
    let lockStarted!: () => void;
    const lockPending = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockSeen = new Promise<void>((resolve) => {
      lockStarted = resolve;
    });
    const execute = vi
      .fn<Execute>()
      .mockImplementationOnce(async () => {
        lockStarted();
        await lockPending;
        return [];
      })
      .mockResolvedValueOnce([{ id: candidate.id }]);
    mocks.transaction.mockImplementation(
      (work: (tx: Transaction) => Promise<boolean>) => work({ execute }),
    );

    const result = SamLoopRepository.tryCreateRun(candidate, admission);
    await lockSeen;
    try {
      expect(execute).toHaveBeenCalledTimes(1);
      const lock = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
      expect(lock.sql).toBe("select pg_advisory_xact_lock(734629105)");
    } finally {
      releaseLock();
    }
    await expect(result).resolves.toBe(true);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    const insert = new PgDialect().sqlToQuery(execute.mock.calls[1][0]);
    expect(insert.sql).toMatch(/insert into "sam_loop_runs"/);
    expect(insert.sql).toContain("select count(*)");
    expect(insert.sql).toContain('"sam_loop_runs"."created_at" >= $4');
    expect(insert.sql).toContain("on conflict do nothing returning id");
    expect(insert.params).toEqual([
      candidate.id,
      candidate.loopId,
      candidate.projectId,
      admission.sinceDate,
      admission.cap,
    ]);
    expect(mocks.directExecute).not.toHaveBeenCalled();
    expect(mocks.d1All).not.toHaveBeenCalled();
  });

  it("returns denied when the locked insert returns no row", async () => {
    const execute = vi.fn<Execute>().mockResolvedValue([]);
    mocks.transaction.mockImplementation(
      (work: (tx: Transaction) => Promise<boolean>) => work({ execute }),
    );

    await expect(
      SamLoopRepository.tryCreateRun(candidate, admission),
    ).resolves.toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(mocks.directExecute).not.toHaveBeenCalled();
    expect(mocks.d1All).not.toHaveBeenCalled();
  });

  it("does not insert or fall back to an unlocked path when lock acquisition fails", async () => {
    const execute = vi
      .fn<Execute>()
      .mockRejectedValue(new Error("lock unavailable"));
    mocks.transaction.mockImplementation(
      (work: (tx: Transaction) => Promise<boolean>) => work({ execute }),
    );

    await expect(
      SamLoopRepository.tryCreateRun(candidate, admission),
    ).rejects.toThrow("lock unavailable");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.directExecute).not.toHaveBeenCalled();
    expect(mocks.d1All).not.toHaveBeenCalled();
  });
});
