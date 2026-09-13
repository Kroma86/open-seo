import { describe, expect, it } from "vitest";
import {
  isSelfHostedMcpOAuthDiscoveryPath,
  isUnderSelfhostOAuthDiscoveryPrefix,
} from "./oauth-resource";

describe("self-hosted MCP OAuth discovery paths", () => {
  it("matches exact discovery endpoints", () => {
    expect(
      isSelfHostedMcpOAuthDiscoveryPath(
        "/.well-known/oauth-authorization-server",
      ),
    ).toBe(true);
    expect(
      isSelfHostedMcpOAuthDiscoveryPath(
        "/.well-known/oauth-authorization-server/mcp",
      ),
    ).toBe(true);
    expect(
      isSelfHostedMcpOAuthDiscoveryPath(
        "/.well-known/oauth-protected-resource/mcp",
      ),
    ).toBe(true);
  });

  it("404-denies other paths under discovery prefixes", () => {
    expect(
      isUnderSelfhostOAuthDiscoveryPrefix(
        "/.well-known/oauth-authorization-server/extra",
      ),
    ).toBe(true);
    expect(
      isSelfHostedMcpOAuthDiscoveryPath(
        "/.well-known/oauth-authorization-server/extra",
      ),
    ).toBe(false);
  });
});
