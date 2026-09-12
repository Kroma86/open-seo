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
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
] as const;
