const MCP_RESOURCE_PATH = "/mcp";
export const MCP_SCOPE = "mcp";
export const MCP_OAUTH_SCOPES = ["offline_access", MCP_SCOPE];

export function getMcpResource(baseUrl: string) {
  return new URL(MCP_RESOURCE_PATH, baseUrl).toString();
}

/** OAuth discovery paths served by @cloudflare/workers-oauth-provider. */
export function isSelfHostedMcpOAuthDiscoveryPath(pathname: string) {
  return (
    pathname === `/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}` ||
    pathname ===
      `/.well-known/oauth-authorization-server${MCP_RESOURCE_PATH}` ||
    pathname === "/.well-known/oauth-authorization-server"
  );
}
