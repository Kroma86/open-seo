/**
 * Cursor MCP OAuth redirect URIs that Cloudflare Access Managed OAuth must
 * allow for Dynamic Client Registration (DCR).
 *
 * Evidence (Cursor 3.20.10 mcpProcessMain `V7()` + live CF Access DCR probe
 * on team throbbing-waterfall-366d, 2026-09-12):
 * - Desktop Shared MCP always DCR-registers this set together:
 *   `cursor://anysphere.cursor-mcp/oauth/callback` (from `q7()` / `N1`)
 *   + `https://www.cursor.com/agents/mcp/oauth/callback`
 *   + `http://localhost:8787/callback`
 * - If ANY URI in the set is missing from Access `allowed_uris` (and is not
 *   covered by allow_any_on_localhost / allow_any_on_loopback), Cloudflare
 *   returns `invalid_client_metadata: redirect_uri is not allowed by the
 *   account configuration` and the whole registration fails.
 * - Cloudflare Access API accepts custom-scheme URIs in `allowed_uris`
 *   ("must be explicitly configured and match exactly"). The dashboard copy
 *   that says "https only" is incomplete — `cursor://…` MUST be listed.
 * - `allow_any_on_localhost` / `allow_any_on_loopback` cover desktop loopback;
 *   the Agents / Bot HTTPS callbacks and `cursor://` must still be listed.
 *
 * @see https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/
 * @see https://cursor.com/docs/mcp
 */
export const CURSOR_MCP_OAUTH_HTTPS_CALLBACK =
  "https://www.cursor.com/agents/mcp/oauth/callback" as const;

/** Grok Bot / Cursor Bot HTTPS callback (added when DCR primary is grokbot://). */
export const CURSOR_MCP_OAUTH_BOT_HTTPS_CALLBACK =
  "https://www.cursor.com/bot/mcp/oauth/callback" as const;

/** Desktop IDE loopback (also covered by allow_any_on_localhost). */
export const CURSOR_MCP_OAUTH_LOOPBACK_CALLBACK =
  "http://localhost:8787/callback" as const;

/**
 * Custom-scheme callback Cursor's mcpProcess still includes in every DCR
 * redirect_uris set via `q7()` → `cursor://anysphere.cursor-mcp/oauth/callback`.
 * Must be explicitly listed in Access `allowed_uris`.
 */
export const CURSOR_MCP_OAUTH_CUSTOM_SCHEME_CALLBACK =
  "cursor://anysphere.cursor-mcp/oauth/callback" as const;

/** Optional Grok Bot custom scheme (only when that client is the primary). */
export const CURSOR_MCP_OAUTH_GROKBOT_CALLBACK =
  "grokbot://mcp/oauth/callback" as const;

/**
 * Full `allowed_uris` for Access Managed OAuth (host + `/mcp` apps).
 * Loopback is also enabled via allow_any_on_localhost / allow_any_on_loopback;
 * listing the fixed Cursor port documents the contract and survives flag drift.
 */
export const CURSOR_MCP_OAUTH_ALLOWED_URIS = [
  CURSOR_MCP_OAUTH_HTTPS_CALLBACK,
  CURSOR_MCP_OAUTH_BOT_HTTPS_CALLBACK,
  CURSOR_MCP_OAUTH_CUSTOM_SCHEME_CALLBACK,
  CURSOR_MCP_OAUTH_LOOPBACK_CALLBACK,
  CURSOR_MCP_OAUTH_GROKBOT_CALLBACK,
] as const;
