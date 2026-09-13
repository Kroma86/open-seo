import { describe, expect, it } from "vitest";
import {
  OAUTH_AUTHORIZE_PATH,
  OAUTH_CONSENT_PAGE_PATH,
  OAUTH_CONSENT_RESPONSE_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_TOKEN_PATH,
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
