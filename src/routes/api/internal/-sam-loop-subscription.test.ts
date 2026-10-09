import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, string>,
  get: vi.fn(),
  post: vi.fn(),
  machine: vi.fn<(headers: Headers, audience: string) => Promise<boolean>>(),
}));
vi.mock("cloudflare:workers", () => ({ env: mocks.env }));
vi.mock("@/db", () => ({
  withPgClient: (operation: () => Promise<unknown>) => operation(),
}));
vi.mock("@/middleware/ensure-user/cloudflareAccess", () => ({
  isAccessServiceTokenFor: mocks.machine,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));
vi.mock("@/server/features/sam-loops/services/subscriptionSamLoops", () => ({
  getSubscriptionLoopRequest: mocks.get,
  postSubscriptionLoopRequest: mocks.post,
}));
import { handleGet, handlePost } from "./sam-loop-subscription";

function request(body: unknown, token?: string) {
  return new Request(
    "https://example.test/api/internal/sam-loop-subscription",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.AGENCY_SCORE_EXPORT_TOKEN = "fixture-internal-token";
  mocks.env.SAM_LOOP_EXECUTOR = "subscription";
  mocks.env.SAM_LOOP_POLICY_AUD = "fixture-sam-loop-aud";
  mocks.machine.mockResolvedValue(true);
});
describe("subscription loop authentication and contract", () => {
  it("rejects anonymous reports before touching a run", async () => {
    expect((await handlePost(request({ action: "complete" }))).status).toBe(
      401,
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("rejects an incorrect bearer", async () => {
    expect((await handlePost(request({}, "wrong"))).status).toBe(401);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("fails closed without existing credentials", async () => {
    delete mocks.env.AGENCY_SCORE_EXPORT_TOKEN;
    expect(
      (await handlePost(request({}, "fixture-internal-token"))).status,
    ).toBe(503);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("rejects a correct bearer without the Access machine login", async () => {
    mocks.machine.mockResolvedValue(false);
    expect(
      (await handlePost(request({}, "fixture-internal-token"))).status,
    ).toBe(401);
    expect(mocks.machine).toHaveBeenCalledWith(
      expect.any(Headers),
      "fixture-sam-loop-aud",
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("fails closed when the Access audience is not configured", async () => {
    delete mocks.env.SAM_LOOP_POLICY_AUD;
    expect(
      (await handlePost(request({}, "fixture-internal-token"))).status,
    ).toBe(503);
    expect(mocks.machine).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it.each([
    ["anonymous", undefined, false, 401],
    ["wrong bearer", "wrong", false, 401],
    ["missing credential", "fixture-internal-token", true, 503],
  ] as const)(
    "rejects GET with %s before reading or mutating",
    async (_name, token, missing, status) => {
      if (missing) delete mocks.env.AGENCY_SCORE_EXPORT_TOKEN;
      const response = await handleGet(
        new Request("https://example.test/api/internal/sam-loop-subscription", {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        }),
      );
      expect(response.status).toBe(status);
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.post).not.toHaveBeenCalled();
    },
  );
  it("never mutates when subscription mode is off", async () => {
    delete mocks.env.SAM_LOOP_EXECUTOR;
    expect(
      (await handlePost(request({}, "fixture-internal-token"))).status,
    ).toBe(409);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("rejects malformed completion with a specific reason", async () => {
    const response = await handlePost(
      request(
        { action: "complete", runId: "not-an-id", result: {} },
        "fixture-internal-token",
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_contract" });
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("allows authenticated read-only previews while routing remains off", async () => {
    delete mocks.env.SAM_LOOP_EXECUTOR;
    mocks.get.mockResolvedValue({ loops: [] });
    const response = await handleGet(
      new Request("https://example.test/api/internal/sam-loop-subscription", {
        headers: { authorization: "Bearer fixture-internal-token" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ loops: [] });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
