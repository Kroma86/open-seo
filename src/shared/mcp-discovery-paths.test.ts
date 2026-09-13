import { describe, expect, it } from "vitest";
import {
  OAUTH_AUTHORIZE_PATH,
  OAUTH_CONSENT_PAGE_PATH,
  OAUTH_CONSENT_RESPONSE_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_TOKEN_PATH,
  SELFHOST_OAUTH_MACHINE_PATH_PREFIXES,
  SELFHOST_OAUTH_PUBLIC_PATH_PREFIXES,
  isSelfHostedMcpOAuthProtocolPath,
} from "./mcp-discovery-paths";

describe("isSelfHostedMcpOAuthProtocolPath", () => {
  it("matches MCP OAuth protocol and consent paths", () => {
    for (const path of [
      OAUTH_AUTHORIZE_PATH,
      OAUTH_TOKEN_PATH,
      OAUTH_REGISTER_PATH,
      OAUTH_CONSENT_RESPONSE_PATH,
      OAUTH_CONSENT_PAGE_PATH,
    ]) {
      expect(isSelfHostedMcpOAuthProtocolPath(path)).toBe(true);
    }
  });

  it("does not match discovery or unrelated app paths", () => {
    expect(
      isSelfHostedMcpOAuthProtocolPath(
        "/.well-known/oauth-authorization-server",
      ),
    ).toBe(false);
    expect(isSelfHostedMcpOAuthProtocolPath("/api/auth/oauth2/other")).toBe(
      false,
    );
    expect(isSelfHostedMcpOAuthProtocolPath("/mcp")).toBe(false);
  });
});

describe("self-host Access public bypass prefixes", () => {
  it("includes token and register, and does not include authorize", () => {
    expect([...SELFHOST_OAUTH_MACHINE_PATH_PREFIXES]).toEqual([
      OAUTH_TOKEN_PATH,
      OAUTH_REGISTER_PATH,
    ]);
    expect([...SELFHOST_OAUTH_PUBLIC_PATH_PREFIXES]).toEqual(
      expect.arrayContaining([...SELFHOST_OAUTH_MACHINE_PATH_PREFIXES]),
    );
    expect(SELFHOST_OAUTH_PUBLIC_PATH_PREFIXES).not.toContain(
      OAUTH_AUTHORIZE_PATH,
    );
    expect(SELFHOST_OAUTH_PUBLIC_PATH_PREFIXES).not.toContain("/api/auth/oauth2");
  });
});

