/**
 * Cursor MCP OAuth redirect URIs that Cloudflare Access Managed OAuth must
 * allow for Dynamic Client Registration (DCR).
 *
 * Evidence (seo.niceseo.ai / team throbbing-waterfall-366d, 2026-09-08):
 * - `allow_any_on_localhost` / `allow_any_on_loopback` cover desktop loopback.
 * - HTTPS callbacks must be listed in `allowed_uris` (CF requires https).
 * - `cursor://anysphere.cursor-mcp/oauth/callback` cannot be allow-listed:
 *   Cloudflare rejects non-https redirect URIs. If a Cursor build DCR-sends
 *   that custom scheme alongside the others, registration still fails.
 *
 * Exact callbacks Cursor uses (desktop + Agents / Grok Bot):
 * @see https://cursor.com/docs/mcp
 */
export const CURSOR_MCP_OAUTH_HTTPS_CALLBACK =
  "https://www.cursor.com/agents/mcp/oauth/callback" as const;

/** Desktop IDE loopback (also covered by allow_any_on_localhost). */
export const CURSOR_MCP_OAUTH_LOOPBACK_CALLBACK =
  "http://localhost:8787/callback" as const;

/**
 * Custom-scheme callback some Cursor builds still send during DCR.
 * Not allow-listable on Cloudflare Access Managed OAuth (https only).
 */
export const CURSOR_MCP_OAUTH_CUSTOM_SCHEME_CALLBACK =
  "cursor://anysphere.cursor-mcp/oauth/callback" as const;

/** HTTPS redirect URIs to put in Access `allowed_uris` (not localhost). */
export const CURSOR_MCP_OAUTH_ALLOWED_URIS = [
  CURSOR_MCP_OAUTH_HTTPS_CALLBACK,
] as const;
