import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(
  () =>
    ({
      TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      POLICY_AUD: "user-app-aud",
      MCP_POLICY_AUD: "mcp-app-aud",
    }) as Env,
);

const joseMocks = vi.hoisted(() => ({
  jwtVerify: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

// Mock jose with just the surface the middleware and its error classifier
// use. The error classes mirror jose's hierarchy (claim-bearing
// JWTClaimValidationFailed under a shared JOSEError base) so the
// aud-mismatch detection under test runs against the same shape as production.
vi.mock("jose", () => {
  class JOSEError extends Error {}
  class JWTClaimValidationFailed extends JOSEError {
    claim: string;
    constructor(message: string, claim: string) {
      super(message);
      this.name = "JWTClaimValidationFailed";
      this.claim = claim;
    }
  }
  class JWTExpired extends JOSEError {}
  class JWKSNoMatchingKey extends JOSEError {}
  class JWKSInvalid extends JOSEError {}
  class JWKSTimeout extends JOSEError {}
  return {
    createRemoteJWKSet: vi.fn(() => ({})),
    jwtVerify: joseMocks.jwtVerify,
    errors: {
      JOSEError,
      JWTClaimValidationFailed,
      JWTExpired,
      JWKSNoMatchingKey,
      JWKSInvalid,
      JWKSTimeout,
    },
  };
});

const delegatedMocks = vi.hoisted(() => ({
  resolveSharedWorkspaceContext: vi.fn(),
}));
vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveSharedWorkspaceContext: delegatedMocks.resolveSharedWorkspaceContext,
}));

import { errors as joseErrors } from "jose";
import {
  resolveCloudflareAccessContext,
  resolveCloudflareAccessMcpGate,
} from "./cloudflareAccess";

const WITH_TOKEN = new Headers({ "cf-access-jwt-assertion": "the-token" });
const WORKSPACE = {
  userId: "u1",
  userEmail: "person@example.com",
  organizationId: "org1",
};

// The runtime class comes from the vi.mock factory above; cast past the real
// jose types, whose constructor takes (message, payload, claim, reason).
const ClaimError = joseErrors.JWTClaimValidationFailed as unknown as new (
  message: string,
  claim: string,
) => Error;

function audMismatch(): Error {
  return new ClaimError('invalid "aud" (audience) claim', "aud");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TEAM_DOMAIN = "https://team.cloudflareaccess.com";
  mockEnv.POLICY_AUD = "user-app-aud";
  mockEnv.MCP_POLICY_AUD = "mcp-app-aud";
  delegatedMocks.resolveSharedWorkspaceContext.mockResolvedValue(
    WORKSPACE as never,
  );
});

describe("resolveCloudflareAccessMcpGate", () => {
  it("classifies a service token (MCP audience + common_name) as service_token", async () => {
    joseMocks.jwtVerify.mockImplementation(
      async (_t: unknown, _k: unknown, opts: { audience: string }) => {
        if (opts.audience === "mcp-app-aud") {
          return {
            payload: { common_name: "abc.service-token", sub: "svc-id" },
          };
        }
        throw audMismatch();
      },
    );

    const gate = await resolveCloudflareAccessMcpGate(WITH_TOKEN);
    expect(gate.kind).toBe("service_token");
  });

  it("falls back to the user audience for a user JWT, returning the verified identity only (context resolution is the caller's DB-scoped job)", async () => {
    joseMocks.jwtVerify.mockImplementation(
      async (_t: unknown, _k: unknown, opts: { audience: string }) => {
        if (opts.audience === "user-app-aud") {
          return { payload: { sub: "u1", email: "person@example.com" } };
        }
        throw audMismatch();
      },
    );

    const gate = await resolveCloudflareAccessMcpGate(WITH_TOKEN);
    expect(gate).toEqual({
      kind: "user",
      userId: "u1",
      userEmail: "person@example.com",
    });
    // The gate must not touch the database — keeping the remote JWKS verify
    // out of any pooled-client scope depends on it.
    expect(
      delegatedMocks.resolveSharedWorkspaceContext,
    ).not.toHaveBeenCalled();
  });

  it("rejects a service-token-shaped JWT at the USER audience (the C1 hole: kind must not follow audience alone)", async () => {
    joseMocks.jwtVerify.mockImplementation(
      async (_t: unknown, _k: unknown, opts: { audience: string }) => {
        if (opts.audience === "user-app-aud") {
          // Service-token claim shape WITH user-looking sub/email — exactly
          // what a misconfigured hostname-wide app would mint for a service
          // token. Before the claim-shape guard this became kind:"user".
          return {
            payload: {
              common_name: "abc.service-token",
              sub: "u1",
              email: "person@example.com",
            },
          };
        }
        throw audMismatch();
      },
    );

    await expect(resolveCloudflareAccessMcpGate(WITH_TOKEN)).rejects.toThrow(
      /UNAUTHENTICATED/,
    );
    expect(
      delegatedMocks.resolveSharedWorkspaceContext,
    ).not.toHaveBeenCalled();
  });

  it("classifies a user-shaped JWT at the MCP audience as user (Managed OAuth for /mcp)", async () => {
    joseMocks.jwtVerify.mockImplementation(
      async (_t: unknown, _k: unknown, opts: { audience: string }) => {
        if (opts.audience === "mcp-app-aud") {
          return { payload: { sub: "u1", email: "person@example.com" } };
        }
        throw audMismatch();
      },
    );

    await expect(resolveCloudflareAccessMcpGate(WITH_TOKEN)).resolves.toEqual({
      kind: "user",
      userId: "u1",
      userEmail: "person@example.com",
    });
  });

  it("rejects with audience-mismatch guidance when both audiences fail", async () => {
    joseMocks.jwtVerify.mockRejectedValue(audMismatch());

    await expect(resolveCloudflareAccessMcpGate(WITH_TOKEN)).rejects.toThrow(
      /audience mismatch/,
    );
  });

  it("pins the jose error contract: only the aud claim mismatch falls through; other claim errors classify and stop", async () => {
    // A non-aud claim failure must NOT be mistaken for an audience mismatch
    // and retried against the second audience — the whole fallback depends
    // on jose setting error.claim === "aud" only for audience failures.
    joseMocks.jwtVerify.mockRejectedValue(
      new ClaimError('invalid "iss" (issuer) claim', "iss"),
    );

    await expect(resolveCloudflareAccessMcpGate(WITH_TOKEN)).rejects.toThrow(
      /issuer mismatch/,
    );
    expect(joseMocks.jwtVerify).toHaveBeenCalledTimes(1);
  });

  it("rejects at config time when both audiences are identical (a user JWT would verify at the MCP audience and die on the claim-shape guard with no guidance)", async () => {
    mockEnv.MCP_POLICY_AUD = "user-app-aud";

    await expect(resolveCloudflareAccessMcpGate(WITH_TOKEN)).rejects.toThrow(
      /identical/,
    );
    expect(joseMocks.jwtVerify).not.toHaveBeenCalled();
  });

  it("rejects when the request carries no Access token", async () => {
    await expect(
      resolveCloudflareAccessMcpGate(new Headers()),
    ).rejects.toThrow(/No Cloudflare Access token/);
    expect(joseMocks.jwtVerify).not.toHaveBeenCalled();
  });
});

describe("resolveCloudflareAccessContext", () => {
  it("never lets a service token through the user door", async () => {
    joseMocks.jwtVerify.mockImplementation(
      async (_t: unknown, _k: unknown, opts: { audience: string }) => {
        if (opts.audience === "mcp-app-aud") {
          return {
            payload: { common_name: "abc.service-token", sub: "svc-id" },
          };
        }
        throw audMismatch();
      },
    );

    await expect(resolveCloudflareAccessContext(WITH_TOKEN)).rejects.toThrow(
      /UNAUTHENTICATED/,
    );
  });

  it("returns the user context for a user JWT", async () => {
    joseMocks.jwtVerify.mockImplementation(
      async (_t: unknown, _k: unknown, opts: { audience: string }) => {
        if (opts.audience === "user-app-aud") {
          return { payload: { sub: "u1", email: "person@example.com" } };
        }
        throw audMismatch();
      },
    );

    await expect(resolveCloudflareAccessContext(WITH_TOKEN)).resolves.toBe(
      WORKSPACE,
    );
  });
});
