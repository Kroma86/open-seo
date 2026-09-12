export const OAUTH_AUTHORIZATION_SERVER_PATH =
  "/.well-known/oauth-authorization-server";
export const OAUTH_PROTECTED_RESOURCE_PATH =
  "/.well-known/oauth-protected-resource";

export const OAUTH_AUTHORIZE_PATH = "/api/auth/oauth2/authorize";
export const OAUTH_TOKEN_PATH = "/api/auth/oauth2/token";
export const OAUTH_REGISTER_PATH = "/api/auth/oauth2/register";
export const OAUTH_CONSENT_RESPONSE_PATH = "/api/oauth/consent";

/**
 * The OAuth discovery path families for self-host MCP, shared by the two
 * allowlists that MUST NOT drift apart:
 * - the Cloudflare Access bypass destinations (alchemy.access.ts) — Access
 *   matches these as path PREFIXES at the edge;
 * - the Worker's exact-match discovery allowlist and its 404 deny
 *   (src/lib/oauth-resource.ts, used in src/server.ts).
 *
 * The edge must never admit more than the Worker will serve: anything under
 * these prefixes that is not an exact discovery path gets a 404 from the
 * Worker, so prefix-matching at the edge cannot open new unauthenticated
 * surface when routes change.
 */
export const SELFHOST_OAUTH_DISCOVERY_PATH_PREFIXES = [
  OAUTH_AUTHORIZATION_SERVER_PATH,
  OAUTH_PROTECTED_RESOURCE_PATH,
] as const;

/**
 * Machine OAuth endpoints (RFC 6749 token + RFC 7591 registration). MCP
 * remint/refresh clients call these from Node without an Access cookie, so
 * the Access edge must Bypass them the same way discovery is bypassed. Do
 * NOT put `/api/auth/oauth2` here as a single prefix — that would also
 * bypass `/authorize`, which must keep the Access JWT so the Worker can
 * identify the user.
 */
export const SELFHOST_OAUTH_MACHINE_PATH_PREFIXES = [
  OAUTH_TOKEN_PATH,
  OAUTH_REGISTER_PATH,
] as const;

/** Destinations for the self-host Access Bypass-everyone OAuth app. */
export const SELFHOST_OAUTH_PUBLIC_PATH_PREFIXES = [
  ...SELFHOST_OAUTH_DISCOVERY_PATH_PREFIXES,
  ...SELFHOST_OAUTH_MACHINE_PATH_PREFIXES,
] as const;

/** Worker-side protocol paths handed to workers-oauth-provider. */
export function isSelfHostedMcpOAuthProtocolPath(pathname: string) {
  return (
    pathname === OAUTH_AUTHORIZE_PATH ||
    pathname === OAUTH_TOKEN_PATH ||
    pathname === OAUTH_REGISTER_PATH ||
    pathname === OAUTH_CONSENT_RESPONSE_PATH
  );
}
