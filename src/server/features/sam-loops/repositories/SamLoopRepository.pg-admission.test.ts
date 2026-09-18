import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  directExecute: vi.fn(),
  d1All: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "postgres" },
}));
vi.mock("@/db", () => ({ db: { all: mocks.d1All } }));
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
      const lock = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
      expect(lock.sql).toBe("select pg_advisory_xact_lock(734629105)");
    } finally {
      releaseLock();
    }
    await expect(result).resolves.toBe(true);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    const insert = new PgDialect().sqlToQuery(execute.mock.calls[1]![0]);
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
