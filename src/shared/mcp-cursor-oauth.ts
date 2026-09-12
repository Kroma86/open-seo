/**
 * Cursor MCP OAuth redirect URIs that Cloudflare Access Managed OAuth must
 * allow for Dynamic Client Registration (DCR).
 *
 * Evidence (seo.niceseo.ai, 2026-09-12):
 * - Cursor 3.20 DCR registers Agents HTTPS + Bot HTTPS + `cursor://` +
 *   `http://localhost:8787/callback` (+ grokbot) **together**.
 * - Cloudflare Access on this account accepts that full set in `allowed_uris`
 *   (including `cursor://` — live PUT verified).
 * - `allow_any_on_localhost` / `allow_any_on_loopback` still help other ports.
 * - Restore script must MERGE these URIs — never replace with Agents-only.
 */
export const CURSOR_MCP_OAUTH_HTTPS_CALLBACK =
  "https://www.cursor.com/agents/mcp/oauth/callback" as const;

export const CURSOR_MCP_OAUTH_BOT_HTTPS_CALLBACK =
  "https://www.cursor.com/bot/mcp/oauth/callback" as const;

/** Desktop IDE loopback (also covered by allow_any_on_localhost). */
export const CURSOR_MCP_OAUTH_LOOPBACK_CALLBACK =
  "http://localhost:8787/callback" as const;

/** Custom-scheme callback Cursor DCR still sends. */
export const CURSOR_MCP_OAUTH_CUSTOM_SCHEME_CALLBACK =
  "cursor://anysphere.cursor-mcp/oauth/callback" as const;

export const GROKBOT_MCP_OAUTH_CALLBACK = "grokbot://mcp/oauth/callback" as const;

/** Redirect URIs to merge into Access Managed OAuth `allowed_uris`. */
export const CURSOR_MCP_OAUTH_ALLOWED_URIS = [
  CURSOR_MCP_OAUTH_HTTPS_CALLBACK,
  CURSOR_MCP_OAUTH_BOT_HTTPS_CALLBACK,
  CURSOR_MCP_OAUTH_CUSTOM_SCHEME_CALLBACK,
  CURSOR_MCP_OAUTH_LOOPBACK_CALLBACK,
  GROKBOT_MCP_OAUTH_CALLBACK,
] as const;
