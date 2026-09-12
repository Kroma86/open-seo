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

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string },
}));

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

let client: Client;
let handleGet: (request: Request) => Promise<Response>;

const TOKEN = "test-export-token";
const BASE = "http://localhost/api/internal/agency-monthly-export";

function request(path: string, headers?: HeadersInit): Request {
  return new Request(`${BASE}${path}`, { headers });
}

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

  ({ handleGet } = await import("./agency-monthly-export"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  await client.execute("DELETE FROM agency_ops_artifacts");
});

async function seedArtifact(input: {
  id: string;
  domain: string | null;
  sourceKey: string;
  content: string;
  receivedAt: string;
}) {
  await client.execute({
    sql: `INSERT INTO agency_ops_artifacts
      (id, kind, domain, date, content_type, content, source_key, received_at)
      VALUES (?, 'monthly-export', ?, '2026-09-01', 'json', ?, ?, ?)`,
    args: [
      input.id,
      input.domain,
      input.content,
      input.sourceKey,
      input.receivedAt,
    ],
  });
}

describe("agency-monthly-export handleGet auth and validation", () => {
  it("returns 503 agency_score_export_disabled when token unset", async () => {
    delete mockEnv.AGENCY_SCORE_EXPORT_TOKEN;
    const res = await handleGet(request("?domain=example.com&month=2026-09"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "agency_score_export_disabled",
    });
  });

  it("returns 401 when bearer is missing", async () => {
    const res = await handleGet(request("?domain=example.com&month=2026-09"));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 when bearer is wrong", async () => {
    const res = await handleGet(
      request("?domain=example.com&month=2026-09", {
        authorization: "Bearer wrong-token",
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 400 invalid_month when month is missing", async () => {
    const res = await handleGet(
      request("?domain=example.com", {
        authorization: `Bearer ${TOKEN}`,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_month",
      hint: "YYYY-MM",
    });
  });

  it("returns 400 invalid_month for malformed month", async () => {
    const res = await handleGet(
      request("?domain=example.com&month=2026-13", {
        authorization: `Bearer ${TOKEN}`,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_month",
      hint: "YYYY-MM",
    });
  });

  it("returns 400 domain_or_index_required when neither is provided", async () => {
    const res = await handleGet(
      request("?month=2026-09", {
        authorization: `Bearer ${TOKEN}`,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "domain_or_index_required" });
  });

  it("returns 400 domain_or_index_required when both are provided", async () => {
    const res = await handleGet(
      request("?domain=example.com&index=1&month=2026-09", {
        authorization: `Bearer ${TOKEN}`,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "domain_or_index_required" });
  });
});

describe("agency-monthly-export handleGet data", () => {
  const auth = { authorization: `Bearer ${TOKEN}` };

  it("returns the latest domain export by receivedAt then id", async () => {
    await seedArtifact({
      id: "older",
      domain: "example.com",
      sourceKey: "monthly-export-example.com-2026-09-v1.json",
      content: JSON.stringify({ version: 1 }),
      receivedAt: "2026-09-01T10:00:00.000Z",
    });
    await seedArtifact({
      id: "newer",
      domain: "example.com",
      sourceKey: "monthly-export-example.com-2026-09-v2.json",
      content: JSON.stringify({ version: 2 }),
      receivedAt: "2026-09-02T10:00:00.000Z",
    });

    const res = await handleGet(
      request("?domain=Example.COM&month=2026-09", auth),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      domain: "example.com",
      month: "2026-09",
      sourceKey: "monthly-export-example.com-2026-09-v2.json",
      receivedAt: "2026-09-02T10:00:00.000Z",
      export: { version: 2 },
    });
  });

  it("normalizes domain query with trailing dot to match stored artifact", async () => {
    await seedArtifact({
      id: "export",
      domain: "example.com",
      sourceKey: "monthly-export-example.com-2026-09.json",
      content: JSON.stringify({ version: 1 }),
      receivedAt: "2026-09-01T10:00:00.000Z",
    });

    const res = await handleGet(
      request("?domain=Example.com.&month=2026-09", auth),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      domain: "example.com",
      month: "2026-09",
      sourceKey: "monthly-export-example.com-2026-09.json",
      receivedAt: "2026-09-01T10:00:00.000Z",
      export: { version: 1 },
    });
  });

  it("breaks receivedAt ties by descending id", async () => {
    await seedArtifact({
      id: "aaa",
      domain: "example.com",
      sourceKey: "monthly-export-example.com-2026-09-a.json",
      content: JSON.stringify({ version: "a" }),
      receivedAt: "2026-09-01T10:00:00.000Z",
    });
    await seedArtifact({
      id: "zzz",
      domain: "example.com",
      sourceKey: "monthly-export-example.com-2026-09-z.json",
      content: JSON.stringify({ version: "z" }),
      receivedAt: "2026-09-01T10:00:00.000Z",
    });

    const res = await handleGet(
      request("?domain=example.com&month=2026-09", auth),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sourceKey: "monthly-export-example.com-2026-09-z.json",
      export: { version: "z" },
    });
  });

  it("ignores domain-null monthly-export rows whose sourceKey is not export-index-", async () => {
    await seedArtifact({
      id: "stray-null-domain",
      domain: null,
      sourceKey: "monthly-export-stray-2026-09.json",
      content: JSON.stringify({ clients: ["stray.example"] }),
      receivedAt: "2026-09-02T12:00:00.000Z",
    });

    const res = await handleGet(request("?index=1&month=2026-09", auth));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("prefers export-index- rows over domain-null non-index monthly-export rows", async () => {
    await seedArtifact({
      id: "stray-null-domain",
      domain: null,
      sourceKey: "monthly-export-stray-2026-09.json",
      content: JSON.stringify({ clients: ["stray.example"] }),
      receivedAt: "2026-09-02T12:00:00.000Z",
    });
    await seedArtifact({
      id: "index",
      domain: null,
      sourceKey: "export-index-2026-09.json",
      content: JSON.stringify({ clients: ["a.com"] }),
      receivedAt: "2026-09-01T12:00:00.000Z",
    });

    const res = await handleGet(request("?index=1&month=2026-09", auth));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      month: "2026-09",
      sourceKey: "export-index-2026-09.json",
      receivedAt: "2026-09-01T12:00:00.000Z",
      index: { clients: ["a.com"] },
    });
  });

  it("returns index export when index=1", async () => {
    await seedArtifact({
      id: "index",
      domain: null,
      sourceKey: "export-index-2026-09.json",
      content: JSON.stringify({ clients: ["a.com"] }),
      receivedAt: "2026-09-01T12:00:00.000Z",
    });

    const res = await handleGet(request("?index=1&month=2026-09", auth));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      month: "2026-09",
      sourceKey: "export-index-2026-09.json",
      receivedAt: "2026-09-01T12:00:00.000Z",
      index: { clients: ["a.com"] },
    });
  });

  it("returns 404 not_found when no artifact matches", async () => {
    const res = await handleGet(
      request("?domain=missing.example&month=2026-09", auth),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns content_invalid with status 200 when stored JSON is invalid", async () => {
    await seedArtifact({
      id: "bad-json",
      domain: "example.com",
      sourceKey: "monthly-export-example.com-2026-09-bad.json",
      content: "not-json",
      receivedAt: "2026-09-01T10:00:00.000Z",
    });

    const res = await handleGet(
      request("?domain=example.com&month=2026-09", auth),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      domain: "example.com",
      month: "2026-09",
      sourceKey: "monthly-export-example.com-2026-09-bad.json",
      receivedAt: "2026-09-01T10:00:00.000Z",
      export: null,
      error: "content_invalid",
    });
  });

  it("returns export null without error when stored JSON is literal null", async () => {
    await seedArtifact({
      id: "null-json",
      domain: "example.com",
      sourceKey: "monthly-export-example.com-2026-09-null.json",
      content: "null",
      receivedAt: "2026-09-01T10:00:00.000Z",
    });

    const res = await handleGet(
      request("?domain=example.com&month=2026-09", auth),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      domain: "example.com",
      month: "2026-09",
      sourceKey: "monthly-export-example.com-2026-09-null.json",
      receivedAt: "2026-09-01T10:00:00.000Z",
      export: null,
    });
  });

  it("returns content_invalid for index when stored JSON is invalid", async () => {
    await seedArtifact({
      id: "bad-index",
      domain: null,
      sourceKey: "export-index-2026-09.json",
      content: "not-json",
      receivedAt: "2026-09-01T12:00:00.000Z",
    });

    const res = await handleGet(request("?index=1&month=2026-09", auth));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      month: "2026-09",
      sourceKey: "export-index-2026-09.json",
      receivedAt: "2026-09-01T12:00:00.000Z",
      index: null,
      error: "content_invalid",
    });
  });

  it("returns index null without error when stored JSON is literal null", async () => {
    await seedArtifact({
      id: "null-index",
      domain: null,
      sourceKey: "export-index-2026-09-null.json",
      content: "null",
      receivedAt: "2026-09-01T12:00:00.000Z",
    });

    const res = await handleGet(request("?index=1&month=2026-09", auth));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      month: "2026-09",
      sourceKey: "export-index-2026-09-null.json",
      receivedAt: "2026-09-01T12:00:00.000Z",
      index: null,
    });
  });
});
