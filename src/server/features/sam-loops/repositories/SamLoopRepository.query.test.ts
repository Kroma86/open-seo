import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import type { Client } from "@libsql/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as SamLoopRepositoryModule from "./SamLoopRepository";
import {
  clearSamLoopsTestDb,
  insertLoop as insertLoopRow,
  insertRun as insertRunRow,
  openSamLoopsTestDb,
  seedProject as seedProjectRow,
} from "./SamLoopRepository.query.fixture";

// Real in-memory SQLite so ensureDefaultLoops idempotence runs against the
// (project_id, name) unique index — the mocked service seed test can't see it.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let SamLoopRepository: typeof SamLoopRepositoryModule.SamLoopRepository;

beforeAll(async () => {
  ({ client, SamLoopRepository } = await openSamLoopsTestDb());
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await clearSamLoopsTestDb(client);
});

const seedProject = () => seedProjectRow(client);
const insertLoop = (input: Parameters<typeof insertLoopRow>[1]) =>
  insertLoopRow(client, input);
const insertRun = (input: Parameters<typeof insertRunRow>[1]) =>
  insertRunRow(client, input);

const byName = (
  loops: Awaited<ReturnType<typeof SamLoopRepository.getLoopsForProject>>,
  name: string,
) => loops.find((loop) => loop.name === name)?.nextRunAt?.slice(0, 10);

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

  it("spreads the same template to different dates for different projects", async () => {
    await client.execute({
      sql: "INSERT INTO projects (id, organization_id, name) VALUES (?, ?, ?)",
      args: ["project_1", "org_1", "Acme"],
    });
    await client.execute({
      sql: "INSERT INTO projects (id, organization_id, name) VALUES (?, ?, ?)",
      args: ["project_2", "org_1", "Beta"],
    });

    await SamLoopRepository.ensureDefaultLoops("project_1");
    await SamLoopRepository.ensureDefaultLoops("project_2");

    const loops1 = await SamLoopRepository.getLoopsForProject("project_1");
    const loops2 = await SamLoopRepository.getLoopsForProject("project_2");
    // Assigned days differ by seed: Site health weekly lands Friday for
    // project_1 (hash%7 = 4) vs Tuesday for project_2 (hash%7 = 1); GBP
    // drift monthly lands on month-day 24 vs 9 (1 + hash%28).
    expect(byName(loops1, "Site health")).toBeDefined();
    expect(byName(loops1, "Site health")).not.toBe(
      byName(loops2, "Site health"),
    );
    expect(byName(loops1, "GBP drift")).toBeDefined();
    expect(byName(loops1, "GBP drift")).not.toBe(byName(loops2, "GBP drift"));
  });
});

describe("getContentVelocityForProject", () => {
  const sinceIso = "2026-07-01T00:00:00.000Z";

  beforeEach(async () => {
    await seedProject();
    await insertLoop({
      id: "loop_content",
      name: "Monthly content",
      cadence: "monthly",
    });
    await insertLoop({
      id: "loop_brief",
      name: "Content brief",
      skillName: "content-brief",
      cadence: "weekly",
    });
    await insertLoop({
      id: "loop_rank",
      name: "Rank check",
      skillName: "rank-slippage",
      cadence: "daily",
    });
  });

  it("returns completed runs for content loops with hasDraft", async () => {
    await insertRun({
      id: "run_1",
      loopId: "loop_content",
      status: "completed",
      finishedAt: "2026-08-15T12:00:00.000Z",
      report: "# Draft",
    });
    await insertRun({
      id: "run_2",
      loopId: "loop_brief",
      status: "completed",
      finishedAt: "2026-09-01T08:00:00.000Z",
      report: null,
    });

    const rows = await SamLoopRepository.getContentVelocityForProject(
      "project_1",
      sinceIso,
    );

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          loopId: "loop_content",
          loopName: "Monthly content",
          cadence: "monthly",
          isEnabled: true,
          finishedAt: "2026-08-15T12:00:00.000Z",
          hasDraft: false,
        }),
        expect.objectContaining({
          loopId: "loop_brief",
          hasDraft: false,
        }),
      ]),
    );
  });

  it("excludes non-content loops such as Rank check", async () => {
    await insertRun({
      id: "run_rank",
      loopId: "loop_rank",
      status: "completed",
      finishedAt: "2026-08-01T00:00:00.000Z",
      report: "report",
    });
    await insertRun({
      id: "run_content",
      loopId: "loop_content",
      status: "completed",
      finishedAt: "2026-08-02T00:00:00.000Z",
      report: "draft",
    });

    const rows = await SamLoopRepository.getContentVelocityForProject(
      "project_1",
      sinceIso,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.loopId).toBe("loop_content");
  });

  it("excludes runs before sinceIso and without finishedAt", async () => {
    await insertRun({
      id: "run_old",
      loopId: "loop_content",
      status: "completed",
      finishedAt: "2026-06-30T23:59:59.000Z",
      report: "old",
    });
    await insertRun({
      id: "run_boundary",
      loopId: "loop_content",
      status: "completed",
      finishedAt: sinceIso,
      report: "on boundary",
    });
    await insertRun({
      id: "run_no_finish",
      loopId: "loop_content",
      status: "completed",
      finishedAt: null,
      report: "no finish",
    });

    const rows = await SamLoopRepository.getContentVelocityForProject(
      "project_1",
      sinceIso,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.finishedAt).toBe(sinceIso);
    expect(rows[0]?.hasDraft).toBe(false);
  });

  it("treats empty-string report as completed without draft", async () => {
    await insertRun({
      id: "run_empty_report",
      loopId: "loop_content",
      status: "completed",
      finishedAt: "2026-08-10T00:00:00.000Z",
      report: "",
    });

    const rows = await SamLoopRepository.getContentVelocityForProject(
      "project_1",
      sinceIso,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.hasDraft).toBe(false);
  });

  it("excludes failed and running runs", async () => {
    await insertRun({
      id: "run_failed",
      loopId: "loop_content",
      status: "failed",
      finishedAt: "2026-08-01T00:00:00.000Z",
      report: null,
    });
    await insertRun({
      id: "run_running",
      loopId: "loop_content",
      status: "running",
      finishedAt: "2026-08-02T00:00:00.000Z",
      report: null,
    });
    await insertRun({
      id: "run_ok",
      loopId: "loop_content",
      status: "completed",
      finishedAt: "2026-08-03T00:00:00.000Z",
      report: "ok",
    });

    const rows = await SamLoopRepository.getContentVelocityForProject(
      "project_1",
      sinceIso,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.finishedAt).toBe("2026-08-03T00:00:00.000Z");
  });
});
