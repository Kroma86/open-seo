import { describe, expect, it } from "vitest";
import {
  OAUTH_AUTHORIZE_PATH,
  OAUTH_CONSENT_RESPONSE_PATH,
  SELFHOST_OAUTH_MACHINE_PATH_PREFIXES,
  SELFHOST_OAUTH_PUBLIC_PATH_PREFIXES,
  isSelfHostedMcpOAuthProtocolPath,
} from "./mcp-discovery-paths";

describe("self-host public OAuth Access prefixes", () => {
  it("bypasses discovery plus token/register, never authorize or consent", () => {
    expect([...SELFHOST_OAUTH_PUBLIC_PATH_PREFIXES]).toEqual([
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/api/auth/oauth2/token",
      "/api/auth/oauth2/register",
    ]);
    expect(SELFHOST_OAUTH_PUBLIC_PATH_PREFIXES).not.toContain(
      OAUTH_AUTHORIZE_PATH,
    );
    expect(SELFHOST_OAUTH_PUBLIC_PATH_PREFIXES).not.toContain(
      OAUTH_CONSENT_RESPONSE_PATH,
    );
    expect([...SELFHOST_OAUTH_MACHINE_PATH_PREFIXES]).toEqual([
      "/api/auth/oauth2/token",
      "/api/auth/oauth2/register",
    ]);
  });

  it("treats authorize, token, register, and consent as Worker protocol paths", () => {
    expect(isSelfHostedMcpOAuthProtocolPath("/api/auth/oauth2/authorize")).toBe(
      true,
    );
    expect(isSelfHostedMcpOAuthProtocolPath("/api/auth/oauth2/token")).toBe(
      true,
    );
    expect(isSelfHostedMcpOAuthProtocolPath("/api/auth/oauth2/register")).toBe(
      true,
    );
    expect(isSelfHostedMcpOAuthProtocolPath("/api/oauth/consent")).toBe(true);
    expect(isSelfHostedMcpOAuthProtocolPath("/api/auth/oauth2/revoke")).toBe(
      false,
    );
    expect(isSelfHostedMcpOAuthProtocolPath("/mcp")).toBe(false);
  });
});
