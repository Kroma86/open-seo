import { readFileSync } from "node:fs";
import { beforeEach, afterAll, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { proposalRejections } from "@/db/app.schema";
import type { ProposalRejection } from "./ProposalRejectionsRepository";

const client = createClient({ url: ":memory:" });
const database = drizzle(client);
vi.mock("@/db", () => ({
  get db() {
    return database;
  },
}));
vi.mock("@/db/schema", () => ({
  get proposalRejections() {
    return proposalRejections;
  },
}));
const { ProposalRejectionsRepository: repo } =
  await import("./ProposalRejectionsRepository");
const row: ProposalRejection = {
  proposalId: "synthetic-id",
  payloadHash: "a".repeat(64),
  domain: "example.test",
  path: "/",
  organizationId: null,
  requestId: "synthetic-request",
  reason: "Synthetic rejection",
  rejectedAt: "2026-01-01T00:00:00.000Z",
  priorStatus: "pending",
  priorPulledAt: null,
};
beforeEach(async () => {
  await client.execute("DROP TABLE IF EXISTS proposal_rejections");
  await client.execute(
    readFileSync("drizzle/0046_proposal_rejections.sql", "utf8"),
  );
});
afterAll(() => client.close());
it("uses the actual SQLite migration and preserves the first row on conflict", async () => {
  expect(await repo.insertIfAbsent(row)).toEqual(row);
  expect(
    await repo.insertIfAbsent({
      ...row,
      requestId: "competing",
      reason: "replacement",
    }),
  ).toEqual(row);
  expect(await repo.findByIds([row.proposalId])).toEqual([row]);
});
it("concurrent callers get the same first-writer receipt", async () => {
  const results = await Promise.all([
    repo.insertIfAbsent(row),
    repo.insertIfAbsent({ ...row, requestId: "other" }),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(await repo.findByIds([row.proposalId, "absent"])).toEqual([
    results[0],
  ]);
});
it("bounds lookup before querying, and propagates database failure", async () => {
  expect(await repo.findByIds([])).toEqual([]);
  await expect(repo.findByIds(Array(76).fill("id"))).rejects.toThrow(
    "lookup_limit",
  );
  await client.execute("DROP TABLE proposal_rejections");
  await expect(repo.findByIds([row.proposalId])).rejects.toThrow();
});
