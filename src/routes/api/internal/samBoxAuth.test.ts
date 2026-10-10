import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as { SAM_LOOP_BOX_TOKEN?: string; SAM_LOOP_GROK_BOX?: string },
}));

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));

import { runSamBoxGates, samBoxJson } from "./samBoxAuth";

const TOKEN = "test-box-token";

function request(body = '{"contract":1}', authorization: string | null = `Bearer ${TOKEN}`): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== null) headers.set("authorization", authorization);
  return new Request("http://localhost/api/internal/sam-box-claim", {
    method: "POST",
    headers,
    body,
  });
}

async function expectDenied(input: Request, status: number, body: Record<string, unknown>) {
  const result = await runSamBoxGates(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected a denied request");
  expect(result.response.status).toBe(status);
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const text = await result.response.text();
  expect(JSON.parse(text)).toEqual(body);
  expect(text).not.toContain(TOKEN);
}

beforeEach(() => {
  mockEnv.SAM_LOOP_BOX_TOKEN = TOKEN;
  mockEnv.SAM_LOOP_GROK_BOX = "on";
});

describe("runSamBoxGates", () => {
  it("disables an unset token before auth, mode and body checks", async () => {
    delete mockEnv.SAM_LOOP_BOX_TOKEN;
    mockEnv.SAM_LOOP_GROK_BOX = "off";
    await expectDenied(request("broken", "Bearer wrong"), 503, { error: "sam_box_disabled" });
  });

  it("disables a blank token", async () => {
    mockEnv.SAM_LOOP_BOX_TOKEN = "   ";
    await expectDenied(request(), 503, { error: "sam_box_disabled" });
  });

  it.each([null, "Bearer wrong", "Token test-box-token", "Bearer test-box-token-extra"])(
    "rejects missing or incorrect bearer %s before mode and body checks",
    async (authorization) => {
      mockEnv.SAM_LOOP_GROK_BOX = "off";
      await expectDenied(request("broken", authorization), 401, { error: "unauthorized" });
    },
  );

  it("rejects mode off before parsing JSON", async () => {
    mockEnv.SAM_LOOP_GROK_BOX = "off";
    await expectDenied(request("broken"), 503, { error: "sam_box_off" });
  });

  it("rejects bad JSON before checking contract", async () => {
    await expectDenied(request('{"contract":2'), 400, { error: "invalid_json" });
  });

  it.each(["null", "[]", "1", '"body"'])("rejects non-object body %s", async (body) => {
    await expectDenied(request(body), 400, { error: "invalid_body" });
  });

  it.each(["{}", '{"contract":2}', '{"contract":"1"}'])("rejects unsupported contract %s", async (body) => {
    await expectDenied(request(body), 400, { error: "unsupported_contract", supported: [1] });
  });

  it("accepts case-insensitive bearer and preserves the body for route validation", async () => {
    mockEnv.SAM_LOOP_BOX_TOKEN = ` ${TOKEN} `;
    const result = await runSamBoxGates(request('{"contract":1,"runner_id":"runner"}', `bEaReR ${TOKEN}`));
    expect(result).toEqual({ ok: true, body: { contract: 1, runner_id: "runner" } });
  });
});

it("samBoxJson preserves status and body with no-store", async () => {
  const response = samBoxJson({ status: 409, body: { error: "lease_mismatch" } });
  expect(response.status).toBe(409);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "lease_mismatch" });
});
