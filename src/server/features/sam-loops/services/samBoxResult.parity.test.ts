import type { Client } from "@libsql/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getAgencyLoopReports,
  type AgencyLoopReport,
} from "@/server/features/agency/AgencyLoopReportsService";
import type { HomegrownOttoProposal } from "@/server/features/agency/AgencyOttoProposalsService";
import type { ToolContext } from "@/server/mcp/context";
import { proposeHomegrownOttoFixesTool } from "@/server/mcp/tools/homegrown-otto-tools";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import { leaseIdFor } from "./samBoxMode";
import { handleSamBoxResult } from "./samBoxResult";

type ParityRun = {
  id: string;
  loopId: string;
  projectId: string;
  status: "running";
  startedAt: string;
  costNote: string;
  report: null;
  error: null;
  proposalsQueued: number;
};

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  dbState: { client: null as Client | null },
  getRunById: vi.fn<(runId: string) => Promise<ParityRun | null>>(),
  getLoopById: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  getProjectById: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  finishRunIfRunning: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  updateLoop: vi.fn<(...args: unknown[]) => Promise<void>>(),
  claimDueLoop: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    DATABASE_PROVIDER: "d1",
    KV: {
      get: async (key: string) => mocks.store.get(key) ?? null,
      put: async (key: string, value: string) =>
        void mocks.store.set(key, value),
    },
  },
}));
vi.mock("@/server/features/sam-loops/repositories/SamLoopRepository", () => ({
  SamLoopRepository: mocks,
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectById: mocks.getProjectById },
}));
// This suite checks the successful proposal mapping. The error redactor's
// implementation and failure handling are covered by the result unit suite.
vi.mock("./runHeadlessSamLoop", () => ({
  generationErrorDetail: () => "Error: test failure",
}));
// The neighbouring export suite also uses actual in-memory SQLite. Keep the
// service and SQL real without mocking an ORM chain or using an external DB.
vi.mock("@/db", async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const client = createClient({ url: "file::memory:" });
  mocks.dbState.client = client;
  return { db: drizzle(client) };
});

const startedAt = "2026-10-07T13:20:00.123Z";
const finishedAt = "2026-10-07T13:21:00.123Z";
const run: ParityRun = {
  id: "10000000-0000-4000-8000-000000000001",
  loopId: "20000000-0000-4000-8000-000000000001",
  projectId: "project-1",
  status: "running",
  startedAt,
  costNote: "box:grok-sub leased",
  report: null,
  error: null,
  proposalsQueued: 0,
};
const projectDomain = "https://www.niceseo.ai/";
const context: ToolContext = {
  auth: {
    userId: "system",
    userEmail: "system@openseo.so",
    organizationId: "org-1",
    clientId: null,
    baseUrl: "https://seo.niceseo.ai",
    scopes: [],
  },
};

function testClient(): Client {
  const client = mocks.dbState.client;
  if (!client) throw new Error("Export test database was not initialized.");
  return client;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(finishedAt);
  await testClient().executeMultiple(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT
    );
    CREATE TABLE sam_loops (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cadence TEXT NOT NULL
    );
    CREATE TABLE sam_loop_runs (
      id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      report TEXT,
      proposals_queued INTEGER NOT NULL DEFAULT 0,
      steps_used INTEGER,
      cost_note TEXT,
      error TEXT
    );
  `);
});

beforeEach(() => {
  mocks.getRunById.mockResolvedValue(run);
  mocks.getLoopById.mockResolvedValue({
    id: run.loopId,
    projectId: run.projectId,
    name: "On-page priorities",
    sourceType: "custom",
    customPrompt: DEFAULT_SAM_LOOP_TEMPLATES.find(
      (template) => template.name === "On-page priorities",
    )?.customPrompt,
    cadence: "weekly",
    nextRunAt: "2026-10-01T13:00:00.000Z",
  });
  mocks.getProjectById.mockResolvedValue({
    id: run.projectId,
    domain: projectDomain,
  });
  mocks.finishRunIfRunning.mockResolvedValue(true);
  mocks.updateLoop.mockResolvedValue(undefined);
  mocks.claimDueLoop.mockResolvedValue(true);
});

afterEach(async () => {
  mocks.store.clear();
  await testClient().executeMultiple(`
    DELETE FROM sam_loop_runs;
    DELETE FROM sam_loops;
    DELETE FROM projects;
  `);
});

afterAll(() => {
  mocks.dbState.client?.close();
  vi.useRealTimers();
});

function storedProposal(): HomegrownOttoProposal {
  const rows = [...mocks.store.entries()].filter(([key]) =>
    key.startsWith("homegrown-otto:proposal:"),
  );
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error("A proposal record was not stored.");
  return JSON.parse(row[1]) as HomegrownOttoProposal;
}

function proposalWithoutGeneratedFields(proposal: HomegrownOttoProposal) {
  const { id, proposedAt, ...stored } = proposal;
  expect(id).toEqual(expect.any(String));
  expect(proposedAt).toEqual(expect.any(String));
  return stored;
}

describe("Sam box proposal KV parity", () => {
  it("stores the same record as propose_homegrown_otto_fixes except generated fields", async () => {
    const proposal = {
      path: "/pricing",
      title: "NiceSEO Pricing",
      description: "Compare NiceSEO plans for your business.",
      h1: "NiceSEO plans",
      before_title: "Pricing",
      rationale: "Use the product name already shown on the page.",
      human_review: ["Check that the plans are current."],
    };
    await proposeHomegrownOttoFixesTool.handler(
      { domain: projectDomain, ...proposal },
      context,
    );
    const toolRecord = storedProposal();
    mocks.store.clear();

    const result = await handleSamBoxResult({
      body: {
        contract: 1,
        lease_id: leaseIdFor(run.id, startedAt),
        run_id: run.id,
        runner_id: "hermes-vm-sam-runner",
        model: "grok-4.6",
        duration_ms: 41234,
        journal_ticket: "a3f1c2d4e5b6478990aabbccddeeff00",
        result: {
          report:
            "Measurements: the pricing page title is Pricing. One proposal was queued for review.",
          proposals: [proposal],
        },
      },
    });

    expect(result).toMatchObject({
      status: 200,
      body: { status: "completed", proposals_queued: 1, replay: false },
    });
    const boxRecord = storedProposal();
    expect(proposalWithoutGeneratedFields(boxRecord)).toEqual(
      proposalWithoutGeneratedFields(toolRecord),
    );
    expect(boxRecord).toMatchObject({
      domain: "niceseo.ai",
      projectId: null,
      status: "pending",
      proposedBy: "sam",
      before: { title: "Pricing", description: null },
      flags: ["source:openseo_sam"],
      pulledAt: null,
    });
  });
});

type StoredRun = Pick<
  AgencyLoopReport,
  "id" | "status" | "report" | "proposalsQueued" | "costNote" | "error"
> & { stepsUsed: number | null };

const exportRuns: StoredRun[] = [
  {
    id: "box-completed",
    status: "completed",
    report:
      "Measurements: the pricing title was measured. One proposal is pending.",
    proposalsQueued: 1,
    stepsUsed: 1,
    costNote: "box:grok-sub grok-4.6 · subscription, no per-use cost · 41s",
    error: null,
  },
  {
    id: "box-failed-after-model",
    status: "failed",
    report:
      "Not measured — Generation did not return a complete valid result. Box runner: model_timeout",
    proposalsQueued: 0,
    stepsUsed: 1,
    costNote: "box:grok-sub (model_timeout)",
    error:
      "Generation did not return a complete valid result. Box runner: model_timeout",
  },
  {
    id: "box-no-model",
    status: "completed",
    report:
      "Not measured — Search Console is not connected for this project. No model call was made.",
    proposalsQueued: 0,
    stepsUsed: 0,
    costNote: "no model call",
    error: null,
  },
  {
    id: "box-expired",
    status: "failed",
    report: "Not measured — Box lease expired before a result was posted.",
    proposalsQueued: 0,
    stepsUsed: null,
    costNote: "box:grok-sub (lease expired)",
    error: "Box lease expired before a result was posted.",
  },
];

async function seedExportRun(row: StoredRun): Promise<void> {
  await testClient().execute({
    sql: `INSERT INTO sam_loop_runs
      (id, loop_id, project_id, status, started_at, finished_at, report,
       proposals_queued, steps_used, cost_note, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.id,
      run.loopId,
      run.projectId,
      row.status,
      startedAt,
      finishedAt,
      row.report,
      row.proposalsQueued,
      row.stepsUsed,
      row.costNote,
      row.error,
    ],
  });
}

function fieldTypes(row: AgencyLoopReport) {
  return Object.fromEntries(
    Object.entries(row).map(([field, value]) => [field, typeof value]),
  );
}

describe("Sam box report export parity", () => {
  it.each(exportRuns)(
    "exports $id with the Workflow field types",
    async (row) => {
      await testClient().execute({
        sql: "INSERT INTO projects (id, name, domain) VALUES (?, ?, ?)",
        args: [run.projectId, "NiceSEO", "niceseo.ai"],
      });
      await testClient().execute({
        sql: "INSERT INTO sam_loops (id, project_id, name, cadence) VALUES (?, ?, ?, ?)",
        args: [run.loopId, run.projectId, "CTR opportunities", "monthly"],
      });
      await seedExportRun(row);
      await seedExportRun({
        id: "workflow-reference",
        status: row.status,
        report: "Workflow report.",
        proposalsQueued: 0,
        stepsUsed: 1,
        costNote: "OpenRouter generation",
        error: row.status === "failed" ? "Workflow generation failed." : null,
      });

      const exported = await getAgencyLoopReports(startedAt);
      expect(exported.count).toBe(2);
      const box = exported.runs.find((item) => item.id === row.id);
      const workflow = exported.runs.find(
        (item) => item.id === "workflow-reference",
      );
      if (!box || !workflow)
        throw new Error("Both run paths must be exported.");
      expect(box).toEqual({
        id: row.id,
        loopId: run.loopId,
        loopName: "CTR opportunities",
        cadence: "monthly",
        projectId: run.projectId,
        projectName: "NiceSEO",
        projectDomain: "niceseo.ai",
        status: row.status,
        startedAt,
        finishedAt,
        report: row.report,
        proposalsQueued: row.proposalsQueued,
        costNote: row.costNote,
        error: row.error,
      });
      expect(fieldTypes(box)).toEqual(fieldTypes(workflow));
    },
  );
});
