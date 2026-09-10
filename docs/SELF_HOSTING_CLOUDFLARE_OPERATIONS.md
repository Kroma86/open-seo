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
   - Add these **exact** HTTPS redirect URIs for Cursor Agents / Grok Bot:
     - `https://www.cursor.com/agents/mcp/oauth/callback`
   - Optional web connectors may use a path ending in `/*`.
   - Cloudflare Access only accepts `https` in `allowed_uris`. The custom
     scheme `cursor://anysphere.cursor-mcp/oauth/callback` **cannot** be
     allow-listed; if a Cursor build DCR-sends it with the others, registration
     fails until that build omits the custom scheme (loopback/Agents HTTPS work).
   - Without this, clients fail DCR with
     `redirect_uri is not allowed by the account configuration` and log in but
     expose no tools. See [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).
7. Save.

Alchemy's Access application sync can turn Managed OAuth OFF or drop
`allowed_uris` on deploy. After a selfhost deploy, either rely on
`ensureSelfhostManagedOAuth` in `alchemy.access.ts`, or re-run:

```bash
python3 scripts/restore-openseo-managed-oauth.py
```

MCP clients should connect to:

```text
https://YOUR_WORKER_HOSTNAME/mcp
```

## Telemetry

OpenSEO collects anonymized telemetry for core usage events: heartbeats with aggregate counts (installs, users, projects, feature usage) tied to a random install ID, sent every 5 minutes during the first two hours after install, then at most once daily. No URLs, keywords, prompts, emails, or IP-derived location are collected, and idle installs send nothing.

To disable it, set `OPENSEO_TELEMETRY_DISABLED=1` in `.env.selfhost` and redeploy. Docker and [legacy deployments](./SELF_HOSTING_CLOUDFLARE_LEGACY.md): set it (or `DO_NOT_TRACK=1`) as an environment variable / Worker variable instead.
