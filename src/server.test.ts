import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appFetch: vi.fn(),
  providerFetch: vi.fn(),
  transport: vi.fn(),
  gate: vi.fn(),
  resolveContext: vi.fn(),
  resolveServiceContext: vi.fn(),
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
  resolveServiceTokenWorkspaceContext: mocks.resolveServiceContext,
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

import handler, { mcpGateErrorResponse } from "./server";
import { AppError } from "@/server/lib/errors";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const env = { AUTH_MODE: "cloudflare_access" } as unknown as Env;
const userContext = {
  userId: "u1",
  userEmail: "person@example.com",
  organizationId: "org1",
} as never;

// A machine caller resolves to its own row in the SAME shared workspace as
// people (organizationId matches userContext's) — that sameness is the point:
// a scheduled job and the person reading its output see one set of projects.
const serviceContext = {
  userId: "cf-service-token:grok-bot.access",
  // Shaped like production (40 hex chars), not the old slug-as-address, so
  // nobody copies a dead format out of this fixture.
  userEmail: "0123456789abcdef0123456789abcdef01234567@service-token.invalid",
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
  it("serves a verified service token from its own machine identity, never the OAuth provider (a headless caller cannot finish a browser login)", async () => {
    mocks.gate.mockResolvedValue({
      kind: "service_token",
      commonName: "grok-bot.access",
    });
    mocks.resolveServiceContext.mockResolvedValue(serviceContext);

    const response = await handler.fetch(mcpRequest(), env, ctx);

    expect(mocks.gate).toHaveBeenCalledTimes(1);
    // The load-bearing claim, and the whole point of the change: Access has
    // already proved this machine, so the request is served. Routing it to the
    // OAuth provider is what produced a permanent 401 for every headless
    // client — the provider demands a bearer no machine can obtain.
    expect(mocks.providerFetch).not.toHaveBeenCalled();
    expect(mocks.resolveServiceContext).toHaveBeenCalledWith("grok-bot.access");
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    // Which identity the transport runs AS is the load-bearing claim — the
    // machine's own context, derived from common_name by serviceTokenIdentity,
    // not a person's and not null. Mirrors the user-context assertion below.
    expect(mocks.transport).toHaveBeenCalledWith(
      expect.any(Request),
      "cloudflare_access",
      env,
      ctx,
      serviceContext,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mcp user handler");
    expect(mocks.appFetch).not.toHaveBeenCalled();
  });

  // Scope: this proves the gate's common_name reaches the resolver UNCHANGED.
  // Whether two names can collapse into one row is decided inside
  // serviceTokenIdentity, which this test mocks out — see
  // serviceTokenIdentity.test.ts for that.
  it("passes the service token's own name through to the resolver unchanged", async () => {
    mocks.gate.mockResolvedValue({
      kind: "service_token",
      commonName: "hermes-box.access",
    });
    mocks.resolveServiceContext.mockResolvedValue(serviceContext);

    await handler.fetch(mcpRequest(), env, ctx);

    expect(mocks.resolveServiceContext).toHaveBeenCalledWith(
      "hermes-box.access",
    );
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

describe("server /mcp outside cloudflare_access", () => {
  it("in local_noauth never reaches the gate or the service-token branch — /mcp is served with an explicit null context", async () => {
    const localEnv = { AUTH_MODE: "local_noauth" } as unknown as Env;

    const response = await handler.fetch(mcpRequest(), localEnv, ctx);

    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.resolveServiceContext).not.toHaveBeenCalled();
    expect(mocks.resolveContext).not.toHaveBeenCalled();
    expect(mocks.transport).toHaveBeenCalledWith(
      expect.any(Request),
      "local_noauth",
      localEnv,
      ctx,
      null,
    );
    expect(response.status).toBe(200);
    expect(mocks.appFetch).not.toHaveBeenCalled();
  });

  it("in hosted the request exits before the gate — hosted routes everything to the OAuth provider, so the Access gate and service branch never run", async () => {
    const hostedEnv = { AUTH_MODE: "hosted" } as unknown as Env;

    const response = await handler.fetch(mcpRequest(), hostedEnv, ctx);

    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.resolveServiceContext).not.toHaveBeenCalled();
    expect(mocks.resolveContext).not.toHaveBeenCalled();
    expect(mocks.transport).not.toHaveBeenCalled();
    // The exit IS the OAuth provider: in hosted every request goes there
    // (the beforeEach stub answers 401 to a request with no bearer).
    expect(mocks.providerFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
    expect(mocks.appFetch).not.toHaveBeenCalled();
  });
});

describe("server /mcp gate failures become responses, not exceptions", () => {
  // Until 2026-09-16 nothing in this file used mockRejectedValue, so the throw
  // path had no coverage — and in production every rejection reached the
  // Workers runtime unhandled and came back as Cloudflare error 1101, a 500.
  it("answers a missing Access identity with 401 and the resource metadata, not a 500", async () => {
    mocks.gate.mockRejectedValue(new AppError("UNAUTHENTICATED"));

    const response = await handler.fetch(mcpRequest(), env, ctx);

    expect(response.status).toBe(401);
    // Without this header an MCP client cannot find the authorization server,
    // so it can never start the OAuth flow — which is the whole point of
    // answering 401 rather than 500.
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://open-seo.test/.well-known/oauth-protected-resource/mcp"',
    );
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.appFetch).not.toHaveBeenCalled();
  });

  it("names a deployment misconfiguration without putting the operator's message in the body", async () => {
    // /mcp answers anonymous callers, so the guidance stays in the Worker log.
    mocks.gate.mockRejectedValue(
      new AppError("AUTH_CONFIG_MISSING", "TEAM_DOMAIN must be https://acme.cloudflareaccess.com"),
    );

    const response = await handler.fetch(mcpRequest(), env, ctx);

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, string>;
    expect(body).toEqual({ error: "server_misconfigured" });
    expect(JSON.stringify(body)).not.toContain("cloudflareaccess.com");
  });

  it("gives an unexpected AppError code the generic 500, not the Access 401", async () => {
    mocks.gate.mockRejectedValue(new AppError("INTERNAL_ERROR"));

    const response = await handler.fetch(mcpRequest(), env, ctx);

    expect(response.status).toBe(500);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("answers a transport failure with a plain 500, not an Access challenge", async () => {
    // Two things at once. It must NOT become a 401 — a transport fault is not
    // an identity problem, and a challenge would send the client off to
    // re-authenticate over something authentication cannot fix. And it must
    // not escape either: an uncaught rejection here is the 1101 this whole
    // change removes. The error is UNAUTHENTICATED on purpose, so only the
    // narrower catch keeps it out of the 401 branch.
    mocks.gate.mockResolvedValue({ kind: "user", userId: "u1", userEmail: "p@example.com" });
    mocks.resolveContext.mockResolvedValue(userContext);
    mocks.transport.mockRejectedValue(new AppError("UNAUTHENTICATED"));

    const response = await handler.fetch(mcpRequest(), env, ctx);

    expect(response.status).toBe(500);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(await response.json()).toEqual({ error: "internal_error" });
  });

  it("answers a machine-identity lookup failure with a plain 500 and no Access challenge", async () => {
    mocks.gate.mockResolvedValue({
      kind: "service_token",
      commonName: "grok-bot.access",
    });
    mocks.resolveServiceContext.mockRejectedValue(new Error("pg exploded"));

    const response = await handler.fetch(mcpRequest(), env, ctx);

    // Identity was already proved by Access, so a failure here is ours. An
    // Access challenge would send the caller off to re-authenticate over
    // something authentication cannot fix.
    expect(response.status).toBe(500);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(JSON.stringify(await response.json())).not.toContain("exploded");
  });

  it("still reaches the MCP handler when the gate succeeds", async () => {
    mocks.gate.mockResolvedValue({ kind: "user", userId: "u1", userEmail: "p@example.com" });
    mocks.resolveContext.mockResolvedValue(userContext);

    const response = await handler.fetch(mcpRequest(), env, ctx);

    expect(mocks.transport).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("mcp user handler");
  });

  it("answers an unrecognised error with a bare 500 and leaks nothing", async () => {
    mocks.gate.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));

    const response = await handler.fetch(mcpRequest(), env, ctx);

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, string>;
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });

  it("answers a workspace lookup failure with a 500, not an Access challenge", async () => {
    // The gate already proved identity, so a failure here is ours, not the
    // caller's — even when it arrives wearing an UNAUTHENTICATED code.
    mocks.gate.mockResolvedValue({ kind: "user", userId: "u1", userEmail: "p@example.com" });
    mocks.resolveContext.mockRejectedValue(new Error("db down"));

    const response = await handler.fetch(mcpRequest(), env, ctx);

    expect(response.status).toBe(500);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(JSON.stringify(await response.json())).not.toContain("db down");
  });

  it("builds the metadata URL from the request's own origin", () => {
    const response = mcpGateErrorResponse(
      new AppError("UNAUTHENTICATED"),
      new Request("https://seo.niceseo.ai/mcp", { method: "POST" }),
    );

    expect(response.headers.get("WWW-Authenticate")).toContain(
      "https://seo.niceseo.ai/.well-known/oauth-protected-resource/mcp",
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

describe("server MCP OAuth protocol routing under cloudflare_access", () => {
  it.each([
    "/api/auth/oauth2/authorize",
    "/api/auth/oauth2/token",
    "/api/auth/oauth2/register",
    "/api/oauth/consent",
  ])("routes %s to the OAuth provider, never the app 404 handler", async (path) => {
    mocks.providerFetch.mockResolvedValue(
      new Response("oauth-protocol", { status: 200 }),
    );

    const response = await handler.fetch(mcpRequest("GET", path), env, ctx);

    expect(mocks.providerFetch).toHaveBeenCalledTimes(1);
    const [routedRequest] = mocks.providerFetch.mock.calls[0] as [Request];
    expect(new URL(routedRequest.url).pathname).toBe(path);
    expect(await response.text()).toBe("oauth-protocol");
    expect(mocks.appFetch).not.toHaveBeenCalled();
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.transport).not.toHaveBeenCalled();
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

  it("does not treat /api/auth/oauth2 as a prefix (authorize sibling /revoke stays on the app)", async () => {
    const response = await handler.fetch(
      mcpRequest("POST", "/api/auth/oauth2/revoke"),
      env,
      ctx,
    );

    expect(mocks.appFetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("app");
    expect(mocks.providerFetch).not.toHaveBeenCalled();
  });
});
