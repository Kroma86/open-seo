import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { vi } from "vitest";

// Real in-memory SQLite so repository queries run against the production
// sam_loops DDL (unique indexes included). Callers must still
// `vi.mock("cloudflare:workers", ...)` in their own test file so it hoists.
export async function openSamLoopsTestDb() {
  const client = createClient({ url: "file::memory:" });
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
        s.includes("CREATE TABLE `sam_loop_runs`") ||
        s.includes("CREATE INDEX `sam_loops_") ||
        s.includes("CREATE UNIQUE INDEX `sam_loops_") ||
        s.includes("CREATE INDEX `sam_loop_runs_") ||
        s.includes("CREATE UNIQUE INDEX `sam_loop_runs_"),
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

  const { SamLoopRepository } = await import("./SamLoopRepository");
  return { client, SamLoopRepository };
}

export async function clearSamLoopsTestDb(client: Client) {
  await client.executeMultiple(`
    DELETE FROM sam_loop_runs;
    DELETE FROM sam_loops;
    DELETE FROM projects;
  `);
}

export async function seedProject(client: Client) {
  await client.execute({
    sql: "INSERT INTO projects (id, organization_id, name) VALUES (?, ?, ?)",
    args: ["project_1", "org_1", "Acme"],
  });
}

export async function insertLoop(
  client: Client,
  input: {
    id: string;
    name: string;
    skillName?: string | null;
    cadence?: string;
    isEnabled?: number;
  },
) {
  await client.execute({
    sql: `INSERT INTO sam_loops (
      id, project_id, name, source_type, skill_name, cadence, is_enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      "project_1",
      input.name,
      input.skillName ? "skill" : "custom",
      input.skillName ?? null,
      input.cadence ?? "monthly",
      input.isEnabled ?? 1,
    ],
  });
}

export async function insertRun(
  client: Client,
  input: {
    id: string;
    loopId: string;
    status: string;
    finishedAt?: string | null;
    report?: string | null;
  },
) {
  await client.execute({
    sql: `INSERT INTO sam_loop_runs (
      id, loop_id, project_id, status, finished_at, report
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.loopId,
      "project_1",
      input.status,
      input.finishedAt ?? null,
      input.report ?? null,
    ],
  });
}
