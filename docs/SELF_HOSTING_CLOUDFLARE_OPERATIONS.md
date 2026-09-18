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

## Alchemy state drift

`pnpm deploy:selfhost` runs a preflight that refuses to deploy when a resource in
the `open-seo/selfhost` state is left mid-reconcile. Terminal statuses between
deploys are `created`, `updated` and `replaced`; `creating`, `updating`,
`deleting` and `replacing` mean a previous deploy was killed before it finished
writing state.

This is what NIC-775 was. `SelfHostMcpAccess` sat at `updating` holding Access
application `1d76ba41-…`, which no longer existed on the account, while the live
app on `seo.niceseo.ai/mcp` was `b490d2fe-…`, created 2026-09-12. Alchemy
observes an Access application by id, missed, fell back to a domain scan, found
the live app but marked it *Unowned* — Access applications carry no alchemy
marker, so takeover is gated behind `--adopt` on purpose — and planned a
`create`. Cloudflare answered `application_already_exists` and the deploy exited
1. It named neither id, so it read as a mystery rather than as drift.

### When the preflight fires

1. Read the state document:

   ```bash
   curl -sS -H "Authorization: Bearer $(jq -r .authToken \
       ~/.alchemy/credentials/default/cloudflare-state-store.json)" \
     -H 'User-Agent: openseo-ops/1.0' \
     "$(jq -r .url ~/.alchemy/credentials/default/cloudflare-state-store.json)\
/state/stacks/open-seo/stages/selfhost/resources/<FQN>" | jq '.status, .attr'
   ```

   The state-store Worker answers 403 (error 1010) without a `User-Agent`.

2. Check whether the id in `attr` still exists in Cloudflare. If it does, the
   resource is merely stuck: settle `status` to `updated` and drop `old`.

3. If it does not, find the live resource on the same domain and point `attr` at
   it (`applicationId`, and `aud` for Access applications — the Worker reads the
   `aud` through `downstream`). Back up the document first.

4. Re-run the preflight. It should report nothing.

### Why `--adopt` is not on by default

`pnpm deploy:selfhost` deliberately does not pass `--adopt`, though
`deploy:postgres` does. `--adopt` lets alchemy take over any Access application
sitting on the domain, which would have healed NIC-775 automatically — and would
also silently seize an app nobody meant to hand over. The preflight makes the
drift visible in seconds, which is the part that was missing; adopting stays an
explicit choice:

```bash
pnpm alchemy deploy --env-file .env.selfhost --stage selfhost --adopt --yes
```

Run that only after step 2 or 3 has confirmed which live resource it will take.

### Do not let a deploy get killed

A self-host deploy takes roughly 90 seconds. Running it through anything that
caps a command at 60 seconds kills it partway through and is the most likely way
to write this state again. Launch it detached and poll the log:

```bash
setsid bash -c 'cd ~/Projects/open-seo && pnpm deploy:selfhost' \
  > /tmp/deploy.log 2>&1 < /dev/null &
```
