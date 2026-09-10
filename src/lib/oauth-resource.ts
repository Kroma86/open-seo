import {
  OAUTH_AUTHORIZATION_SERVER_PATH,
  OAUTH_PROTECTED_RESOURCE_PATH,
  SELFHOST_OAUTH_DISCOVERY_PATH_PREFIXES,
} from "@/shared/mcp-discovery-paths";

const MCP_RESOURCE_PATH = "/mcp";
export const MCP_SCOPE = "mcp";
export const MCP_OAUTH_SCOPES = ["offline_access", MCP_SCOPE];

export function getMcpResource(baseUrl: string) {
  return new URL(MCP_RESOURCE_PATH, baseUrl).toString();
}

/** OAuth discovery paths served by @cloudflare/workers-oauth-provider. */
export function isSelfHostedMcpOAuthDiscoveryPath(pathname: string) {
  return (
    pathname === `${OAUTH_PROTECTED_RESOURCE_PATH}${MCP_RESOURCE_PATH}` ||
    pathname === `${OAUTH_AUTHORIZATION_SERVER_PATH}${MCP_RESOURCE_PATH}` ||
    pathname === OAUTH_AUTHORIZATION_SERVER_PATH
  );
}

/**
 * Anything under the discovery prefixes. The edge bypass is prefix-matched,
 * so the Worker must 404 every prefix member that is NOT an exact discovery
 * path — otherwise the bypass would silently admit more than we serve.
 */
export function isUnderSelfhostOAuthDiscoveryPrefix(pathname: string) {
  return SELFHOST_OAUTH_DISCOVERY_PATH_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}
