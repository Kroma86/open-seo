import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv, claim, result, abandon } = vi.hoisted(() => ({
  mockEnv: {} as { SAM_LOOP_BOX_TOKEN?: string; SAM_LOOP_GROK_BOX?: string },
  claim: vi.fn(),
  result: vi.fn(),
  abandon: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));
vi.mock("@/server/features/sam-loops/services/samBoxClaim", () => ({
  handleSamBoxClaim: claim,
}));
vi.mock("@/server/features/sam-loops/services/samBoxResult", () => ({
  handleSamBoxResult: result,
  handleSamBoxAbandon: abandon,
}));

import { handlePost as claimPost, Route as claimRoute } from "./sam-box-claim";
import {
  handlePost as resultPost,
  Route as resultRoute,
} from "./sam-box-result";
import {
  handlePost as abandonPost,
  Route as abandonRoute,
} from "./sam-box-abandon";

const TOKEN = "route-test-token";
const routes = [
  {
    name: "claim",
    post: claimPost,
    route: claimRoute,
    service: claim,
    body: {
      contract: 1,
      runner_id: "runner",
      kinds: ["ctr_opportunities"],
      max_prompt_bytes: 28000,
    },
  },
  {
    name: "result",
    post: resultPost,
    route: resultRoute,
    service: result,
    body: {
      contract: 1,
      run_id: "run",
      lease_id: "run.1",
      runner_id: "runner",
      model: "grok-4.6",
      duration_ms: 1,
      journal_ticket: "a".repeat(32),
      result: { report: "Measurements", proposals: [] },
    },
  },
  {
    name: "abandon",
    post: abandonPost,
    route: abandonRoute,
    service: abandon,
    body: {
      contract: 1,
      run_id: "run",
      lease_id: "run.1",
      runner_id: "runner",
      stage: "before_model",
      code: "controller_active",
    },
  },
];

function request(
  body: string,
  authorization: string | null = `Bearer ${TOKEN}`,
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== null) headers.set("authorization", authorization);
  return new Request("http://localhost/api/internal/sam-box-test", {
    method: "POST",
    headers,
    body,
  });
}

async function expectResponse(
  response: Response,
  status: number,
  body: Record<string, unknown>,
) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual(body);
}

beforeEach(() => {
  mockEnv.SAM_LOOP_BOX_TOKEN = TOKEN;
  mockEnv.SAM_LOOP_GROK_BOX = "on";
  for (const { service } of routes)
    service.mockResolvedValue({ status: 200, body: { ok: true } });
});

for (const { name, post, route, service, body } of routes) {
  describe(`sam-box-${name}`, () => {
    async function denied(
      input: Request,
      status: number,
      expected: Record<string, unknown>,
    ) {
      await expectResponse(await post(input), status, expected);
      expect(service).not.toHaveBeenCalled();
    }

    it.each([undefined, "   "])(
      "disables missing or blank token %s before other gates",
      async (token) => {
        mockEnv.SAM_LOOP_BOX_TOKEN = token;
        mockEnv.SAM_LOOP_GROK_BOX = "off";
        await denied(request("broken", "Bearer wrong"), 503, {
          error: "sam_box_disabled",
        });
      },
    );

    it.each([
      null,
      "Bearer wrong",
      "Bearer route-test-token-extra",
      "Token route-test-token",
    ])("rejects bearer %s before mode and body", async (authorization) => {
      mockEnv.SAM_LOOP_GROK_BOX = "off";
      await denied(request("broken", authorization), 401, {
        error: "unauthorized",
      });
    });

    it("rejects mode off before parsing the body", async () => {
      mockEnv.SAM_LOOP_GROK_BOX = "off";
      await denied(request("broken"), 503, { error: "sam_box_off" });
    });

    it("rejects invalid JSON", async () => {
      await denied(request('{"contract":2'), 400, { error: "invalid_json" });
    });

    it.each(["null", "[]", "1", '"body"'])(
      "rejects non-object %s before contract",
      async (raw) => {
        await denied(request(raw), 400, { error: "invalid_body" });
      },
    );

    it.each([{}, { contract: 2 }, { contract: "1" }])(
      "rejects unsupported contract %j",
      async (raw) => {
        await denied(request(JSON.stringify(raw)), 400, {
          error: "unsupported_contract",
          supported: [1],
        });
      },
    );

    it("delegates the parsed body and preserves successful service output", async () => {
      const output = { contract: 1, ok: true, replay: false };
      service.mockResolvedValue({ status: 200, body: output });
      await expectResponse(
        await post(request(JSON.stringify(body), `bEaReR ${TOKEN}`)),
        200,
        output,
      );
      expect(service).toHaveBeenCalledExactlyOnceWith(
        name === "claim" ? { env: mockEnv, body } : { body },
      );
    });

    it.each([409, 422, 500])(
      "preserves service status %s and body",
      async (status) => {
        const output = {
          error: "service_error",
          metadata: { preserved: true },
        };
        service.mockResolvedValue({ status, body: output });
        await expectResponse(
          await post(request(JSON.stringify(body))),
          status,
          output,
        );
      },
    );

    it("returns strict-parser rejection from the service for unknown keys", async () => {
      // Services own Zod strict envelope parsing; this asserts the route boundary,
      // while service suites prove actual rejection without a mocked parser.
      service.mockResolvedValue({
        status: 400,
        body: { error: "invalid_body" },
      });
      const unknownBody = { ...body, unknown_key: true };
      await expectResponse(
        await post(request(JSON.stringify(unknownBody))),
        400,
        { error: "invalid_body" },
      );
      expect(service).toHaveBeenCalledExactlyOnceWith(
        name === "claim"
          ? { env: mockEnv, body: unknownBody }
          : { body: unknownBody },
      );
    });

    it("registers a POST handler", () => {
      expect(route.options.server?.handlers).toEqual({
        POST: expect.any(Function),
      });
    });
  });
}
