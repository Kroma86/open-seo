import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv, ingest } = vi.hoisted(() => ({
  mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string },
  ingest: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

vi.mock("@/server/features/agency/AgencyOpsArtifactsService", () => ({
  AgencyOpsArtifactsService: {
    ingest: (...args: unknown[]) => ingest(...args),
  },
}));

import { handlePost } from "./agency-ops-artifacts";

const TOKEN = "test-export-token";
const BASE = "http://localhost/api/internal/agency-ops-artifacts";

function post(
  body?: unknown,
  headers?: HeadersInit,
  rawBody?: string,
): Request {
  return new Request(BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
}

const validBody = {
  kind: "alert-cycle",
  domain: "example.com",
  date: "2026-08-31",
  contentType: "json",
  content: '{"alerts":[]}',
  sourceKey: "alerts-2026-08-31.json",
};

beforeEach(() => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  ingest.mockResolvedValue({ id: "artifact_1", deduped: false });
});

describe("agency-ops-artifacts handlePost", () => {
  it("returns 503 agency_score_export_disabled when token unset", async () => {
    delete mockEnv.AGENCY_SCORE_EXPORT_TOKEN;
    const res = await handlePost(post(validBody));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "agency_score_export_disabled",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 503 agency_score_export_disabled when token empty", async () => {
    mockEnv.AGENCY_SCORE_EXPORT_TOKEN = "   ";
    const res = await handlePost(post(validBody));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "agency_score_export_disabled",
    });
  });

  it("returns 401 when bearer is missing", async () => {
    const res = await handlePost(post(validBody));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 when bearer is wrong", async () => {
    const res = await handlePost(
      post(validBody, { authorization: "Bearer wrong-token" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 400 invalid_json on malformed JSON", async () => {
    const res = await handlePost(
      post(undefined, { authorization: `Bearer ${TOKEN}` }, "{not-json"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("returns 400 kind_invalid for bad kind", async () => {
    ingest.mockRejectedValue(new Error("kind_invalid"));
    const res = await handlePost(
      post(
        { ...validBody, kind: "not-a-kind" },
        { authorization: `Bearer ${TOKEN}` },
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "kind_invalid" });
  });

  it("returns 400 date_invalid for bad date", async () => {
    ingest.mockRejectedValue(new Error("date_invalid"));
    const res = await handlePost(
      post(
        { ...validBody, date: "08-31-2026" },
        { authorization: `Bearer ${TOKEN}` },
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "date_invalid" });
  });

  it("returns 400 content_invalid for oversize content", async () => {
    ingest.mockRejectedValue(new Error("content_invalid"));
    const res = await handlePost(
      post(
        { ...validBody, content: "x".repeat(262_145) },
        { authorization: `Bearer ${TOKEN}` },
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "content_invalid" });
  });

  it("returns 500 ingest_failed (no internal message) on non-validation errors", async () => {
    ingest.mockRejectedValue(new Error("LibsqlError: connection refused"));
    const res = await handlePost(
      post(validBody, { authorization: `Bearer ${TOKEN}` }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "ingest_failed" });
  });

  it("returns 500 for the repository conflict-lookup error", async () => {
    ingest.mockRejectedValue(new Error("ingest_conflict_lookup_failed"));
    const res = await handlePost(
      post(validBody, { authorization: `Bearer ${TOKEN}` }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "ingest_failed" });
  });

  it("returns 201 on happy path", async () => {
    const res = await handlePost(
      post(validBody, { authorization: `Bearer ${TOKEN}` }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ id: "artifact_1" });
    expect(ingest).toHaveBeenCalledWith(validBody);
  });

  it("returns 200 deduped on repeat sourceKey", async () => {
    ingest.mockResolvedValue({ id: "artifact_1", deduped: true });
    const res = await handlePost(
      post(validBody, { authorization: `Bearer ${TOKEN}` }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "artifact_1", deduped: true });
  });
});
