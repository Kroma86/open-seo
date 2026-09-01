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
import type * as AgencyOpsArtifactsServiceModule from "./AgencyOpsArtifactsService";

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let AgencyOpsArtifactsService: typeof AgencyOpsArtifactsServiceModule.AgencyOpsArtifactsService;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(`
    CREATE TABLE agency_ops_artifacts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      domain TEXT,
      date TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content TEXT NOT NULL,
      source_key TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX agency_ops_artifacts_kind_source_key_idx
      ON agency_ops_artifacts (kind, source_key);
  `);

  ({ AgencyOpsArtifactsService } = await import("./AgencyOpsArtifactsService"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.execute("DELETE FROM agency_ops_artifacts");
});

const baseInput = {
  kind: "alert-cycle" as const,
  domain: "example.com",
  date: "2026-08-31",
  contentType: "json" as const,
  // Shape matches what the box actually writes: snake_case keys.
  content: JSON.stringify({
    generated_at: "2026-08-31T12:00:00.000Z",
    counts_by_severity: { high: 2, medium: 1 },
    alerts: [
      {
        severity: "high",
        type: "rank_drop",
        domain: "a.com",
        message: "Dropped 5 positions",
      },
      {
        severity: "HIGH",
        type: "crawl_error",
        domain: null,
        message: "5xx spike",
      },
      { severity: "medium", type: "info", domain: "c.com", message: "note" },
    ],
  }),
  sourceKey: "alerts-2026-08-31.json",
};

describe("AgencyOpsArtifactsService", () => {
  it("inserts a new artifact", async () => {
    const result = await AgencyOpsArtifactsService.ingest(baseInput);
    expect(result.deduped).toBe(false);
    expect(result.id).toBeTruthy();

    const row = await AgencyOpsArtifactsService.getArtifact(result.id);
    expect(row?.sourceKey).toBe(baseInput.sourceKey);
  });

  it("dedupes on repeat kind + sourceKey", async () => {
    const first = await AgencyOpsArtifactsService.ingest(baseInput);
    const second = await AgencyOpsArtifactsService.ingest(baseInput);
    expect(second).toEqual({ id: first.id, deduped: true });
  });

  it("lists metadata ordered by receivedAt desc without content", async () => {
    const first = await AgencyOpsArtifactsService.ingest({
      ...baseInput,
      sourceKey: "older.json",
      date: "2026-08-30",
    });
    const second = await AgencyOpsArtifactsService.ingest({
      ...baseInput,
      sourceKey: "newer.json",
      date: "2026-08-31",
    });
    await client.execute({
      sql: "UPDATE agency_ops_artifacts SET received_at = ? WHERE id = ?",
      args: ["2026-08-30T00:00:00.000Z", first.id],
    });
    await client.execute({
      sql: "UPDATE agency_ops_artifacts SET received_at = ? WHERE id = ?",
      args: ["2026-08-31T00:00:00.000Z", second.id],
    });

    const listed = await AgencyOpsArtifactsService.listArtifacts({ limit: 10 });
    expect(listed).toHaveLength(2);
    expect(listed[0]?.sourceKey).toBe("newer.json");
    expect(listed[1]?.sourceKey).toBe("older.json");
    for (const row of listed) {
      expect(row).not.toHaveProperty("content");
    }
  });

  it("filters list by kind", async () => {
    await AgencyOpsArtifactsService.ingest(baseInput);
    await AgencyOpsArtifactsService.ingest({
      ...baseInput,
      kind: "digest",
      sourceKey: "digest.md",
      contentType: "markdown",
      content: "# Digest",
    });

    const alerts = await AgencyOpsArtifactsService.listArtifacts({
      kind: "alert-cycle",
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("alert-cycle");
  });

  it("latestAlertCycle parses the box's snake_case shape, case-insensitive severity, null domain", async () => {
    await AgencyOpsArtifactsService.ingest(baseInput);
    const latest = await AgencyOpsArtifactsService.latestAlertCycle();
    expect(latest).toMatchObject({
      generatedAt: "2026-08-31T12:00:00.000Z",
      countsBySeverity: { high: 2, medium: 1 },
      highCount: 2,
      highAlerts: [
        { type: "rank_drop", domain: "a.com", message: "Dropped 5 positions" },
        { type: "crawl_error", domain: null, message: "5xx spike" },
      ],
    });
  });

  it("latestAlertCycle counts all high-tier alerts beyond the 10-item cap", async () => {
    const manyHigh = Array.from({ length: 14 }, (_, i) => ({
      severity: i % 2 === 0 ? "high" : "critical",
      type: "rank_drop",
      domain: `d${i}.com`,
      message: `drop ${i}`,
    }));
    await AgencyOpsArtifactsService.ingest({
      ...baseInput,
      content: JSON.stringify({
        generated_at: "2026-08-31T12:00:00.000Z",
        counts_by_severity: { high: 14 },
        alerts: manyHigh,
      }),
    });
    const latest = await AgencyOpsArtifactsService.latestAlertCycle();
    expect(latest).toMatchObject({ highCount: 14 });
    if (latest && "highAlerts" in latest) {
      expect(latest.highAlerts).toHaveLength(10);
    } else {
      throw new Error("expected parsed alert cycle");
    }
  });

  it("latestAlertCycle returns parseError on malformed JSON content", async () => {
    await AgencyOpsArtifactsService.ingest({
      ...baseInput,
      content: "not-json",
    });
    const latest = await AgencyOpsArtifactsService.latestAlertCycle();
    expect(latest).toMatchObject({ parseError: true });
    expect(latest?.receivedAt).toBeTruthy();
  });

  it("latestAlertCycle returns parseError when the root is a JSON array", async () => {
    await AgencyOpsArtifactsService.ingest({
      ...baseInput,
      content: "[]",
    });
    const latest = await AgencyOpsArtifactsService.latestAlertCycle();
    expect(latest).toMatchObject({ parseError: true });
  });

  it("ingest rejects invalid bodies with the contract error strings", async () => {
    await expect(
      AgencyOpsArtifactsService.ingest({ ...baseInput, kind: "nope" }),
    ).rejects.toThrow("kind_invalid");
    await expect(
      AgencyOpsArtifactsService.ingest({ ...baseInput, date: "31-08-2026" }),
    ).rejects.toThrow("date_invalid");
    await expect(
      AgencyOpsArtifactsService.ingest({
        ...baseInput,
        content: "x".repeat(262_145),
      }),
    ).rejects.toThrow("content_invalid");
    await expect(
      AgencyOpsArtifactsService.ingest({ ...baseInput, sourceKey: "" }),
    ).rejects.toThrow("sourceKey_invalid");
    await expect(
      AgencyOpsArtifactsService.ingest({ ...baseInput, domain: 42 }),
    ).rejects.toThrow("domain_invalid");
  });
});
