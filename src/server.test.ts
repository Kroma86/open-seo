import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appFetch: vi.fn(),
  providerFetch: vi.fn(),
  transport: vi.fn(),
  gate: vi.fn(),
  resolveContext: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  WorkflowEntrypoint: class {},
  DurableObject: class {},
  WorkerEntrypoint: class {},
  waitUntil: (promise: Promise<unknown>) => void promise,
}));
vi.mock("cloudflare:workflows", () => ({
  WorkflowEntrypoint: class {},
}));
vi.mock("@tanstack/react-start/server", () => ({
  createStartHandler: () => mocks.appFetch,
  defaultStreamHandler: vi.fn(),
}));
vi.mock("agents", () => ({
  routeAgentRequest: vi.fn(async () => undefined),
  Agent: class {},
}));
vi.mock("@/middleware/ensure-user/cloudflareAccess", () => ({
  resolveCloudflareAccessMcpGate: mocks.gate,
}));
vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveSharedWorkspaceContext: mocks.resolveContext,
}));
vi.mock("@/server/mcp/oauth-provider", () => ({
  createOpenSeoOAuthProvider: () => ({
    fetch: mocks.providerFetch,
    purgeExpiredData: vi.fn(async () => ({ done: true })),
  }),
}));
vi.mock("@/server/mcp/transport", () => ({
  handleSelfHostedOpenSeoMcpRequest: mocks.transport,
}));
vi.mock("@/db", () => ({
  withPgClient: (fn: () => unknown) => fn(),
}));
vi.mock("@/server/lib/self-host-telemetry", () => ({
  maybeSendSelfHostHeartbeat: vi.fn(async () => {}),
}));

// The routing under test never touches the workflow/DO leaves, but server.ts
// re-exports them and their import chains (agents, @cloudflare/ai-chat)
// import cloudflare:* specifiers from node_modules, which vitest externalizes
// and node cannot load. Stub the leaves.
vi.mock("@/server/workflows/SiteAuditWorkflow", () => ({
  SiteAuditWorkflow: class {},
}));
vi.mock("@/server/workflows/RankCheckWorkflow", () => ({
  RankCheckWorkflow: class {},
}));
vi.mock("@/server/workflows/SamLoopWorkflow", () => ({
  SamLoopWorkflow: class {},
}));
vi.mock("@/server/features/onboarding/OnboardingChatAgent", () => ({
  OnboardingChatAgent: class {},
}));
vi.mock("@/server/features/sam/SamChatAgent", () => ({
  SamChatAgent: class {},
}));
vi.mock("@/server/features/audit/AuditScratchpad", () => ({
  AuditScratchpad: class {},
}));

import handler from "./server";
import { AppError } from "@/server/lib/errors";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const env = { AUTH_MODE: "cloudflare_access" } as unknown as Env;
const userContext = {
  userId: "u1",
  userEmail: "person@example.com",
  organizationId: "org1",
} as never;

function mcpRequest(method = "POST", path = "/mcp") {
  return new Request(`https://open-seo.test${path}`, { method });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.appFetch.mockResolvedValue(new Response("app"));
  mocks.providerFetch.mockResolvedValue(
    new Response("missing bearer", { status: 401 }),
  );
  mocks.transport.mockResolvedValue(new Response("mcp user handler"));
});

describe("server /mcp routing under cloudflare_access", () => {
  it("hands a service token to the OAuth provider (never the user handler) — the provider's answer, including 401, is what the client gets", async () => {
    mocks.gate.mockResolvedValue({ kind: "service_token" });

    const response = await handler.fetch(mcpRequest(), env, ctx);

    expect(mocks.gate).toHaveBeenCalledTimes(1);
    expect(mocks.providerFetch).toHaveBeenCalledTimes(1);
    const [routedRequest] = mocks.providerFetch.mock.calls[0] as [Request];
    expect(new URL(routedRequest.url).pathname).toBe("/mcp");
    // The load-bearing claim: a service token only ever reaches the OAuth
    // provider, which requires a bearer token on its apiRoute (/mcp) — a
    // request without one comes back 401 (mocked here; the 401-on-missing-
    // bearer behavior is the workers-oauth-provider library's contract on
    // `apiRoute`, doubled in tests because the library cannot run under
    // vitest — see oauth-provider.test.ts's module double).
    expect(response.status).toBe(401);
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.appFetch).not.toHaveBeenCalled();
  });

  it("hands a user gate result to the user MCP handler with the DB-resolved context (its own short client scope, after the network wait)", async () => {
    mocks.gate.mockResolvedValue({
      kind: "user",
      userId: "u1",
      userEmail: "person@example.com",
    });
    mocks.resolveContext.mockResolvedValue(userContext);

    const response = await handler.fetch(mcpRequest(), env, ctx);

    expect(mocks.resolveContext).toHaveBeenCalledWith(
      "u1",
      "person@example.com",
    );
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    expect(mocks.transport).toHaveBeenCalledWith(
      expect.any(Request),
      "cloudflare_access",
      env,
      ctx,
      userContext,
    );
    expect(await response.text()).toBe("mcp user handler");
    expect(mocks.providerFetch).not.toHaveBeenCalled();
  });

  it("returns 401 JSON instead of throwing when the Access gate rejects (avoids Cloudflare 1101 auth loops)", async () => {
    mocks.gate.mockRejectedValue(new AppError("UNAUTHENTICATED"));

    const response = await handler.fetch(mcpRequest(), env, ctx);
    const body = (await response.json()) as {
      error: string;
      error_description: string;
      resource_metadata: string;
    };

    expect(response.status).toBe(401);
    expect(body.error).toBe("invalid_token");
    expect(body.resource_metadata).toContain(
      "cloudflare-access-protected-resource/mcp",
    );
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it("passes OPTIONS preflight to the user handler with an explicit null context, without calling the gate", async () => {
    await handler.fetch(mcpRequest("OPTIONS"), env, ctx);

    // Routing is the whole assertion here: the 200 status would come from the
    // mocked transport, not from any real preflight logic (see M3-5).
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.transport).toHaveBeenCalledWith(
      expect.any(Request),
      "cloudflare_access",
      env,
      ctx,
      null,
    );
  });
});

describe("server OAuth discovery routing under cloudflare_access", () => {
  it("routes the bare authorization-server discovery path to the OAuth provider without the Access gate", async () => {
    mocks.providerFetch.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await handler.fetch(
      mcpRequest("GET", "/.well-known/oauth-authorization-server"),
      env,
      ctx,
    );

    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.providerFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it("rewrites the /mcp-suffixed discovery path before handing it to the provider", async () => {
    await handler.fetch(
      mcpRequest("GET", "/.well-known/oauth-authorization-server/mcp"),
      env,
      ctx,
    );

    expect(mocks.providerFetch).toHaveBeenCalledTimes(1);
    const [routedRequest] = mocks.providerFetch.mock.calls[0] as [Request];
    expect(new URL(routedRequest.url).pathname).toBe(
      "/.well-known/oauth-authorization-server",
    );
  });

  it("404s anything under the discovery prefixes that is not an exact discovery path (the edge bypass is prefix-matched; the Worker allowlist is exact)", async () => {
    const response = await handler.fetch(
      mcpRequest("GET", "/.well-known/oauth-authorization-server/admin"),
      env,
      ctx,
    );

    expect(response.status).toBe(404);
    expect(mocks.providerFetch).not.toHaveBeenCalled();
    expect(mocks.appFetch).not.toHaveBeenCalled();
    expect(mocks.gate).not.toHaveBeenCalled();
  });
});

describe("server fallthrough", () => {
  it("passes unrelated paths to the app handler", async () => {
    const response = await handler.fetch(
      mcpRequest("GET", "/keywords"),
      env,
      ctx,
    );

    expect(mocks.appFetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("app");
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.providerFetch).not.toHaveBeenCalled();
  });
});
