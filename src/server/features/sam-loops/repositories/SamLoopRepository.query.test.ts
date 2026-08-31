import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import type * as SamLoopRepositoryModule from "./SamLoopRepository";

// Real in-memory SQLite so ensureDefaultLoops idempotence runs against the
// (project_id, name) unique index — the mocked service seed test can't see it.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let SamLoopRepository: typeof SamLoopRepositoryModule.SamLoopRepository;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  // testDb only exists at runtime, so the module under test must load after
  // the mock is registered (vi.doMock is not hoisted).
  vi.doMock("@/db", () => ({ db: testDb }));

  // Stub projects for the FK; pull sam_loops DDL from the real migration so
  // the unique index can't drift from production.
  const migration = readFileSync("drizzle/0043_sweet_tenebrous.sql", "utf8");
  const samLoopsDdl = migration
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.includes("CREATE TABLE `sam_loops`") ||
        s.includes("CREATE INDEX `sam_loops_") ||
        s.includes("CREATE UNIQUE INDEX `sam_loops_"),
    )
    .join("\n");

  await client.executeMultiple(
    [
      `CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        archived_at TEXT
      );`,
      samLoopsDdl,
    ].join("\n"),
  );

  ({ SamLoopRepository } = await import("./SamLoopRepository"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM sam_loops;
    DELETE FROM projects;
  `);
});

describe("ensureDefaultLoops", () => {
  it("second pass inserts nothing against the real unique index", async () => {
    await client.execute({
      sql: "INSERT INTO projects (id, organization_id, name) VALUES (?, ?, ?)",
      args: ["project_1", "org_1", "Acme"],
    });

    const first = await SamLoopRepository.ensureDefaultLoops("project_1");
    expect(first).toHaveLength(DEFAULT_SAM_LOOP_TEMPLATES.length);

    const second = await SamLoopRepository.ensureDefaultLoops("project_1");
    expect(second).toEqual([]);

    const loops = await SamLoopRepository.getLoopsForProject("project_1");
    expect(loops).toHaveLength(DEFAULT_SAM_LOOP_TEMPLATES.length);
  });
});
