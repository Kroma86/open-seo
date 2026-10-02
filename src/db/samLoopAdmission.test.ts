import { type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  all: vi.fn<(query: SQL) => Promise<Array<{ id: string }>>>(),
  transaction: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("./index", () => ({ db: { all: mocks.all } }));
vi.mock("./pg/client", () => ({
  pgDb: { transaction: mocks.transaction },
}));
vi.mock("./runBatch", () => ({ runD1RawBatch: vi.fn() }));

import { tryCreateAdmittedSamLoopRun } from "./samLoopSubscriptionWrites";

describe("D1 atomic Sam admission", () => {
  it.each([true, false])(
    "uses one counted insert; admitted=%s",
    async (admitted) => {
      mocks.all.mockResolvedValue(admitted ? [{ id: "run_fixture" }] : []);
      await expect(
        tryCreateAdmittedSamLoopRun(
          {
            id: "run_fixture",
            loopId: "loop_fixture",
            projectId: "project_fixture",
          },
          { sinceDate: "2026-10-01", cap: 40 },
        ),
      ).resolves.toBe(admitted);
      expect(mocks.all).toHaveBeenCalledTimes(1);
      const query: SQL = mocks.all.mock.calls[0][0];
      const compiled = new SQLiteAsyncDialect().sqlToQuery(query);
      expect(compiled.sql).toContain("select count(*)");
      expect(compiled.sql).toContain("on conflict do nothing returning id");
      expect(compiled.params).toEqual([
        "run_fixture",
        "loop_fixture",
        "project_fixture",
        "2026-10-01",
        40,
      ]);
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );
  it("propagates a failed insert without an unlocked fallback", async () => {
    mocks.all.mockRejectedValue(new Error("database unavailable"));
    await expect(
      tryCreateAdmittedSamLoopRun(
        {
          id: "run_fixture",
          loopId: "loop_fixture",
          projectId: "project_fixture",
        },
        { sinceDate: "2026-10-01", cap: 40 },
      ),
    ).rejects.toThrow("database unavailable");
    expect(mocks.all).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
