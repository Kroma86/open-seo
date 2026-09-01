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
import { AppError } from "@/server/lib/errors";
import type * as ProjectRepositoryModule from "./ProjectRepository";
import type * as ProjectServiceModule from "../services/ProjectService";

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let ProjectRepository: typeof ProjectRepositoryModule.ProjectRepository;
let normalizeProjectDomain: typeof ProjectRepositoryModule.normalizeProjectDomain;
let setLoopsEnabled: typeof ProjectServiceModule.setLoopsEnabled;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/server/features/projects/services/projects", () => ({
    archiveProject: vi.fn(),
    createProject: vi.fn(),
    getProjectForOrganization: vi.fn(),
    listArchivedProjects: vi.fn(),
    listProjects: vi.fn(),
    listProjectsEnsuringOne: vi.fn(),
    restoreProject: vi.fn(),
    setProjectDomain: vi.fn(),
    setProjectMarket: vi.fn(),
    updateProject: vi.fn(),
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
      archived_at TEXT,
      loops_enabled INTEGER NOT NULL DEFAULT 0
    );
  `);

  ({ ProjectRepository, normalizeProjectDomain } = await import(
    "./ProjectRepository"
  ));
  ({ setLoopsEnabled } = await import("../services/ProjectService"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.execute("DELETE FROM projects");
});

async function insertProject(input: {
  id: string;
  domain?: string | null;
  archivedAt?: string | null;
  loopsEnabled?: number;
  organizationId?: string;
}) {
  await client.execute({
    sql: `INSERT INTO projects (
      id, organization_id, name, domain, archived_at, loops_enabled
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.organizationId ?? "org_1",
      input.id,
      input.domain ?? null,
      input.archivedAt ?? null,
      input.loopsEnabled ?? 0,
    ],
  });
}

describe("normalizeProjectDomain", () => {
  it("strips :port after the host", () => {
    expect(normalizeProjectDomain("niceseo.ai:8080")).toBe("niceseo.ai");
  });
});

describe("getProjectsByDomain / getProjectByDomain", () => {
  it("matches a stored WWW.Example.com row against example.com in SQL", async () => {
    await insertProject({ id: "project_www", domain: "WWW.Example.com" });

    const rows = await ProjectRepository.getProjectsByDomain("example.com");
    expect(rows.map((row) => row.id)).toEqual(["project_www"]);
    await expect(
      ProjectRepository.getProjectByDomain("example.com"),
    ).resolves.toEqual(expect.objectContaining({ id: "project_www" }));
  });

  it("returns every unarchived row whose lower(domain) matches the host or www.host", async () => {
    await insertProject({ id: "project_a", domain: "example.com" });
    await insertProject({ id: "project_b", domain: "www.example.com" });
    await insertProject({
      id: "project_archived",
      domain: "example.com",
      archivedAt: "2026-08-01 00:00:00",
    });

    const rows = await ProjectRepository.getProjectsByDomain("example.com");
    expect(rows.map((row) => row.id).sort()).toEqual([
      "project_a",
      "project_b",
    ]);
  });

  it("looks up niceseo.ai:8080 as niceseo.ai", async () => {
    await insertProject({ id: "project_port", domain: "niceseo.ai" });

    const rows = await ProjectRepository.getProjectsByDomain("niceseo.ai:8080");
    expect(rows.map((row) => row.domain)).toEqual(["niceseo.ai"]);
  });

  it("matches stored scheme and trailing-slash forms against a bare host", async () => {
    await insertProject({
      id: "project_https",
      domain: "https://client.com/",
    });
    await insertProject({
      id: "project_https_www",
      domain: "https://www.client.com/",
    });
    await insertProject({
      id: "project_http",
      domain: "http://client.com/",
    });
    await insertProject({
      id: "project_http_www",
      domain: "http://www.client.com/",
    });

    const rows = await ProjectRepository.getProjectsByDomain("client.com");
    expect(rows.map((row) => row.id).sort()).toEqual([
      "project_http",
      "project_http_www",
      "project_https",
      "project_https_www",
    ]);
  });
});

describe("setLoopsEnabled", () => {
  it("updates an unarchived row", async () => {
    await insertProject({ id: "project_live", domain: "example.com" });

    const updated = await ProjectRepository.setLoopsEnabled(
      "project_live",
      "org_1",
      true,
    );
    expect(updated).toEqual(
      expect.objectContaining({ id: "project_live", loopsEnabled: true }),
    );
  });

  it("changes 0 rows on an archived project so the service throws NOT_FOUND", async () => {
    await insertProject({
      id: "project_archived",
      domain: "example.com",
      archivedAt: "2026-08-01 00:00:00",
      loopsEnabled: 0,
    });

    await expect(
      setLoopsEnabled("org_1", "project_archived", true),
    ).rejects.toEqual(new AppError("NOT_FOUND"));

    const stored = await client.execute({
      sql: "SELECT loops_enabled FROM projects WHERE id = ?",
      args: ["project_archived"],
    });
    expect(stored.rows[0]?.loops_enabled).toBe(0);
  });
});

describe("archiveProject", () => {
  it("clears loopsEnabled in the same update that sets archivedAt", async () => {
    await insertProject({
      id: "project_flagged",
      domain: "example.com",
      loopsEnabled: 1,
    });

    await ProjectRepository.archiveProject("project_flagged", "org_1");

    const stored = await client.execute({
      sql: "SELECT loops_enabled, archived_at FROM projects WHERE id = ?",
      args: ["project_flagged"],
    });
    expect(stored.rows[0]?.loops_enabled).toBe(0);
    expect(stored.rows[0]?.archived_at).toBeTruthy();
  });
});
