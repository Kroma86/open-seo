# Cloudflare Self-Hosting: Operations

Day-to-day tasks after [initial setup](./SELF_HOSTING_CLOUDFLARE.md): connect the MCP server and manage telemetry. Updating and teammate access are covered in the [deploy guide](./SELF_HOSTING_CLOUDFLARE.md) (or the [legacy page](./SELF_HOSTING_CLOUDFLARE_LEGACY.md) for pre-alchemy deployments).

## Connect the MCP server through Cloudflare Access

Use the same Cloudflare Access application that protects your OpenSEO Worker.
Managed OAuth is required for MCP clients and is not enabled by default.

1. Open Cloudflare Zero Trust.
2. Go to `Access controls` -> `Applications`.
3. Find your OpenSEO application, then select `Edit`.
4. Go to `Additional settings` -> `OAuth`.
5. Turn on `Managed OAuth`.
6. In `Managed OAuth settings`, allow the redirect URIs your MCP clients use:
   - Allow `localhost` / loopback clients for CLI and desktop agents (Codex
     CLI, Claude Code, Cursor desktop) that register `http://localhost:PORT/callback`
     (Cursor desktop uses `http://localhost:8787/callback`).
   - Add these **exact** redirect URIs (Cursor 3.20+ DCR sends them **together**;
     missing any one fails the whole registration):
     - `https://www.cursor.com/agents/mcp/oauth/callback`
     - `https://www.cursor.com/bot/mcp/oauth/callback`
     - `cursor://anysphere.cursor-mcp/oauth/callback` (custom scheme — Access
       API allows these when listed exactly; dashboard “https only” copy is
       incomplete)
     - `http://localhost:8787/callback` (also covered by allow-localhost)
     - `grokbot://mcp/oauth/callback` (Grok Bot)
   - Optional web connectors may use a path ending in `/*`.
   - Without this, clients fail DCR with
     `redirect_uri is not allowed by the account configuration` and log in but
     expose no tools. See [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).
7. Save.

Alchemy's Access application sync can turn Managed OAuth OFF or drop
`allowed_uris` on deploy. The path-scoped `/mcp` Access app must keep both
the email **Allow** policy and Service Auth — Service Auth alone returns
Access **Forbidden 403** to browsers and Cursor Managed OAuth (the host
app's Managed OAuth never applies because `/mcp` is a more-specific app).
After a selfhost deploy, re-run:

```bash
python3 scripts/restore-openseo-managed-oauth.py
```

That restores Managed OAuth on the hostname app **and** on
`… mcp (…/mcp)`, and re-attaches the email Allow policy on `/mcp`.

Healthy probe (no Access cookie): `GET /mcp` returns **401** JSON
`invalid_token` with `WWW-Authenticate` pointing at
`/.well-known/cloudflare-access-protected-resource/mcp` — not the Access
Forbidden HTML page.

MCP clients should connect to:

```text
https://YOUR_WORKER_HOSTNAME/mcp
```

## NiceSEO desk remint and refresh (Worker OAuth)

Cursor desktop DCR still includes `cursor://anysphere.cursor-mcp/oauth/callback`
alongside localhost + Agents HTTPS. That custom scheme **must** be listed in
Access Managed OAuth `allowed_uris` (Access API supports exact custom-scheme
entries). Permanent Access for Grok Bot / desk is still the **Worker**
OAuth server advertised at:

```text
https://seo.niceseo.ai/.well-known/oauth-authorization-server
```

- Authorize and consent stay behind the Cloudflare Access **email session**
  (the Worker needs `Cf-Access-Jwt-Assertion`). After Access login the
  Worker must show Allow/consent, not `Not found`.
- Token and register are Access **bypass** (same pattern as discovery) so
  Node remint/refresh can call them without an Access cookie. The Worker
  still checks the client, PKCE, and refresh material.

One-shot remint (desk Chrome with a live Access session; do not retry on the
broken `Not found` page):

```bash
# Host is https://seo.niceseo.ai. The RFC 8707 resource indicator is
# https://seo.niceseo.ai/mcp (the Worker rejects a host-only resource).
node ~/grok-scratch/openseo_mcp_login_pw.mjs
```

Refresh cron (no browser, no Cursor DCR). Posts to the Worker token
endpoint with the stored refresh material:

```bash
bash ~/Projects/agency-seo/scripts/openseo-mcp-refresh.sh
```

Approval gate: do not leftover-apply.
Approval gate: do not print tokens.

## Telemetry

OpenSEO collects anonymized telemetry for core usage events: heartbeats with aggregate counts (installs, users, projects, feature usage) tied to a random install ID, sent every 5 minutes during the first two hours after install, then at most once daily. No URLs, keywords, prompts, emails, or IP-derived location are collected, and idle installs send nothing.

To disable it, set `OPENSEO_TELEMETRY_DISABLED=1` in `.env.selfhost` and redeploy. Docker and [legacy deployments](./SELF_HOSTING_CLOUDFLARE_LEGACY.md): set it (or `DO_NOT_TRACK=1`) as an environment variable / Worker variable instead.
