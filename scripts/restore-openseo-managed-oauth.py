#!/usr/bin/env python3
"""Re-enable Cloudflare Access Managed OAuth + Cursor DCR redirect allow-list.

Alchemy's Access.Application resource does not pass oauth_configuration, so a
drift-sync PUT can turn Managed OAuth OFF and drop allowed_uris. A service-
token-only /mcp app also returns bare Forbidden 403 to browsers / Cursor
Managed OAuth — this script re-attaches the email Allow policy on /mcp and
turns Managed OAuth ON for both the hostname app and the path-scoped /mcp app.

Cursor 3.20+ Shared MCP DCR always registers this redirect_uris set together
(see src/shared/mcp-cursor-oauth.ts). Missing ANY member (especially
cursor://…) yields:

  redirect_uri is not allowed by the account configuration

Run after every selfhost deploy (also wired into `pnpm deploy:selfhost`).

Uses ~/.alchemy/credentials/default/cf-oauth.json (refreshes if needed).
Defaults to the NiceSEO selfhost Access apps on account 9e030055…; override with
OPENSEO_ACCESS_ACCOUNT_ID / OPENSEO_ACCESS_APP_ID / OPENSEO_MCP_ACCESS_APP_ID /
OPENSEO_ACCESS_ALLOW_POLICY_ID / OPENSEO_MCP_SERVICE_POLICY_ID.
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

# Set by --dry-run: read the apps and print the exact body that would be PUT,
# but write nothing. NIC-775 asked for this because the script runs
# unattended at the tail of `pnpm deploy:selfhost`, where a bad allow-list
# would silently drop live callbacks (Grok Bot's among them).
DRY_RUN = False

ACCOUNT_ID = os.environ.get(
    "OPENSEO_ACCESS_ACCOUNT_ID", "9e03005588cee6cae23a89b800c2beb3"
)
# Hostname-wide email gate (dashboard + authorize).
HOST_APP_ID = os.environ.get(
    "OPENSEO_ACCESS_APP_ID", "844fa8f4-e4d5-46e7-8db8-61b93b6b582c"
)
# Path-scoped /mcp app (Service Auth + identity Allow for Cursor Managed OAuth).
MCP_APP_ID = os.environ.get(
    "OPENSEO_MCP_ACCESS_APP_ID", "b490d2fe-08b6-4e43-89a5-d2946d2ad6b1"
)
ALLOW_POLICY_ID = os.environ.get(
    "OPENSEO_ACCESS_ALLOW_POLICY_ID", "94d588ea-7536-449d-bb01-90bfe9048126"
)
MCP_SERVICE_POLICY_ID = os.environ.get(
    "OPENSEO_MCP_SERVICE_POLICY_ID", "1add80cd-6351-4260-9871-104563ebd340"
)

# Keep in sync with src/shared/mcp-cursor-oauth.ts CURSOR_MCP_OAUTH_ALLOWED_URIS.
CURSOR_AGENTS_HTTPS = "https://www.cursor.com/agents/mcp/oauth/callback"
CURSOR_BOT_HTTPS = "https://www.cursor.com/bot/mcp/oauth/callback"
CURSOR_CUSTOM_SCHEME = "cursor://anysphere.cursor-mcp/oauth/callback"
CURSOR_LOOPBACK = "http://localhost:8787/callback"
CURSOR_GROKBOT = "grokbot://mcp/oauth/callback"
ALLOWED_URIS = [
    CURSOR_AGENTS_HTTPS,
    CURSOR_BOT_HTTPS,
    CURSOR_CUSTOM_SCHEME,
    CURSOR_LOOPBACK,
    CURSOR_GROKBOT,
]

# Exact multi-URI set Cursor mcpProcess V7(Rt) registers for desktop DCR.
CURSOR_DESKTOP_DCR_URIS = [
    CURSOR_CUSTOM_SCHEME,
    CURSOR_AGENTS_HTTPS,
    CURSOR_LOOPBACK,
]

OAUTH_CLIENT_ID = "6d8c2255-0773-45f6-b376-2914632e6f91"
OAUTH_REDIRECT_URI = "http://localhost:9976/auth/callback"
CRED_PATH = Path.home() / ".alchemy/credentials/default/cf-oauth.json"
UA = "Mozilla/5.0 (compatible; openseo-managed-oauth-restore/1.2)"
TEAM_AS = "https://throbbing-waterfall-366d.cloudflareaccess.com"

OAUTH_CONFIGURATION = {
    "enabled": True,
    "dynamic_client_registration": {
        "enabled": True,
        "allow_any_on_localhost": True,
        "allow_any_on_loopback": True,
        "allowed_uris": list(ALLOWED_URIS),
    },
}


def load_creds() -> dict:
    return json.loads(CRED_PATH.read_text())


def save_creds(creds: dict) -> None:
    CRED_PATH.write_text(json.dumps(creds))


def refresh(creds: dict) -> dict:
    body = urllib.parse.urlencode(
        {
            "grant_type": "refresh_token",
            "refresh_token": creds["refresh"],
            "client_id": OAUTH_CLIENT_ID,
            "redirect_uri": OAUTH_REDIRECT_URI,
        }
    ).encode()
    req = urllib.request.Request(
        "https://dash.cloudflare.com/oauth2/token",
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": UA,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)
    refreshed = {
        "type": "oauth",
        "access": data["access_token"],
        "refresh": data.get("refresh_token", creds["refresh"]),
        "expires": int(time.time() * 1000) + int(data["expires_in"]) * 1000,
        "scopes": data.get("scope", "").split(),
    }
    save_creds(refreshed)
    return refreshed


def api(token: str, method: str, path: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": UA,
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def get_app(token: str, app_id: str) -> dict:
    return api(token, "GET", f"/accounts/{ACCOUNT_ID}/access/apps/{app_id}")["result"]


def put_app(token: str, app_id: str, body: dict) -> dict:
    if DRY_RUN:
        print(f"  [dry-run] would PUT /access/apps/{app_id}:")
        print("   ", json.dumps(body, indent=2).replace("\n", "\n    "))
        # Shaped like a real response so callers can keep reading .result.
        return {"success": True, "result": {**body, "id": app_id, "dry_run": True}}
    return api(token, "PUT", f"/accounts/{ACCOUNT_ID}/access/apps/{app_id}", body)


def report_uri_delta(label: str, app: dict, body: dict) -> None:
    """Say plainly what the allow-list write does to the live list.

    The whole point of the merge is that nothing live is ever dropped, so make
    that checkable instead of asking the reader to trust it.
    """
    before = (
        (app.get("oauth_configuration") or {})
        .get("dynamic_client_registration", {})
        .get("allowed_uris")
    ) or []
    after = body["oauth_configuration"]["dynamic_client_registration"]["allowed_uris"]
    added = [u for u in after if u not in before]
    dropped = [u for u in before if u not in after]
    print(f"  {label} allowed_uris: {len(before)} live -> {len(after)} after")
    for uri in added:
        print(f"    + {uri}")
    for uri in dropped:
        print(f"    - {uri}   <-- DROPPED")
    if dropped:
        raise SystemExit(
            f"refusing to write: would drop {len(dropped)} live callback(s) from "
            f"{label}. The merge is supposed to make this impossible; investigate "
            "before re-running."
        )


def merge_allowed_uris(existing: list | None) -> list[str]:
    """Union existing allow-list with the Cursor contract — never drop extras."""
    merged: list[str] = []
    seen: set[str] = set()
    for uri in list(ALLOWED_URIS) + list(existing or []):
        if uri and uri not in seen:
            seen.add(uri)
            merged.append(uri)
    return merged


def oauth_body_for_app(app: dict) -> dict:
    existing = (
        (app.get("oauth_configuration") or {})
        .get("dynamic_client_registration", {})
        .get("allowed_uris")
    )
    return {
        "enabled": True,
        "dynamic_client_registration": {
            "enabled": True,
            "allow_any_on_localhost": True,
            "allow_any_on_loopback": True,
            "allowed_uris": merge_allowed_uris(existing),
        },
    }


def restore_host(token: str) -> None:
    app = get_app(token, HOST_APP_ID)
    print("host app:", app.get("name"), app.get("domain"))
    print("host before:", json.dumps(app.get("oauth_configuration"), indent=2))
    body = {
        k: v
        for k, v in {
            "name": app.get("name"),
            "domain": app.get("domain"),
            "type": app.get("type"),
            "session_duration": app.get("session_duration"),
            "auto_redirect_to_identity": app.get("auto_redirect_to_identity"),
            "destinations": app.get("destinations"),
            "policies": app.get("policies"),
            "oauth_configuration": oauth_body_for_app(app),
        }.items()
        if v is not None
    }
    report_uri_delta("host", app, body)
    updated = put_app(token, HOST_APP_ID, body)
    print("host put success:", updated.get("success"))
    print(
        "host after:",
        json.dumps(updated["result"].get("oauth_configuration"), indent=2),
    )


def restore_mcp(token: str) -> None:
    app = get_app(token, MCP_APP_ID)
    print("mcp app:", app.get("name"), app.get("domain"))
    print("mcp before oauth:", json.dumps(app.get("oauth_configuration"), indent=2))
    print("mcp before policies:", json.dumps(app.get("policies"), indent=2)[:800])
    # Identity Allow first (browser / Cursor), Service Auth second (machines).
    body = {
        k: v
        for k, v in {
            "name": app.get("name"),
            "domain": app.get("domain"),
            "type": app.get("type"),
            "session_duration": app.get("session_duration") or "730h",
            "auto_redirect_to_identity": app.get("auto_redirect_to_identity"),
            "destinations": app.get("destinations"),
            "policies": [ALLOW_POLICY_ID, MCP_SERVICE_POLICY_ID],
            "oauth_configuration": oauth_body_for_app(app),
        }.items()
        if v is not None
    }
    report_uri_delta("mcp", app, body)
    updated = put_app(token, MCP_APP_ID, body)
    result = updated["result"]
    print("mcp put success:", updated.get("success"))
    print("mcp after oauth:", json.dumps(result.get("oauth_configuration"), indent=2))
    print("mcp after policies:")
    for policy in result.get("policies") or []:
        if isinstance(policy, dict):
            print(
                " ",
                policy.get("id"),
                policy.get("name"),
                policy.get("decision"),
            )
        else:
            print(" ", policy)


def verify_dcr(retries: int = 6, delay_s: float = 2.0) -> bool:
    """POST Cursor's desktop DCR redirect_uris set to the team registration endpoint.

    Access can take a few seconds to honor newly written allowed_uris — retry.
    """
    reg = f"{TEAM_AS}/cdn-cgi/access/oauth/registration"
    body = json.dumps(
        {
            "client_name": f"openseo-dcr-verify-{uuid.uuid4().hex[:8]}",
            "redirect_uris": list(CURSOR_DESKTOP_DCR_URIS),
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        }
    ).encode()
    last_err = ""
    for attempt in range(1, retries + 1):
        # Fresh client_name each attempt so retries are not confused with prior OK.
        payload = json.loads(body)
        payload["client_name"] = f"openseo-dcr-verify-{uuid.uuid4().hex[:8]}"
        req = urllib.request.Request(
            reg,
            data=json.dumps(payload).encode(),
            method="POST",
            headers={
                "User-Agent": UA,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.load(resp)
            # Never print secrets — only client_id + redirect_uris echo.
            print(
                "DCR verify OK:",
                {
                    "client_id": data.get("client_id"),
                    "redirect_uris": data.get("redirect_uris"),
                    "attempt": attempt,
                },
            )
            return True
        except urllib.error.HTTPError as err:
            last_err = err.read()[:400].decode("utf-8", "replace")
            print(f"DCR verify attempt {attempt}/{retries} FAIL:", err.code, last_err)
            if attempt < retries:
                time.sleep(delay_s)
    print("DCR verify FAIL after retries:", last_err)
    return False


def probe_mcp_health() -> None:
    req = urllib.request.Request(
        "https://seo.niceseo.ai/mcp",
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            print("GET /mcp unexpected success:", resp.status)
    except urllib.error.HTTPError as err:
        body = err.read()[:300].decode("utf-8", "replace")
        www = err.headers.get("WWW-Authenticate", "")
        print(f"GET /mcp → {err.code} body={body!r}")
        print(f"WWW-Authenticate: {www[:200]}")


def main() -> int:
    global DRY_RUN
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="read the apps and print what would be written; change nothing",
    )
    DRY_RUN = parser.parse_args().dry_run
    if DRY_RUN:
        print("DRY RUN — no Access application will be modified\n")

    creds = load_creds()
    # Refresh when within 5 minutes of expiry (or already past).
    if int(creds.get("expires") or 0) < int(time.time() * 1000) + 300_000:
        print("refreshing alchemy Cloudflare OAuth credentials…")
        creds = refresh(creds)

    token = creds["access"]
    try:
        restore_host(token)
        restore_mcp(token)
    except urllib.error.HTTPError as err:
        if err.code == 401:
            print("access token rejected; refreshing…")
            creds = refresh(creds)
            token = creds["access"]
            restore_host(token)
            restore_mcp(token)
        else:
            raise

    print("\nAllowed callbacks (host + /mcp):")
    for uri in ALLOWED_URIS:
        print(f"  - {uri}")
    print("  - http://localhost:*/callback  (via allow_any_on_localhost)")
    print("  - http://127.0.0.1:*/callback (via allow_any_on_loopback)")

    if DRY_RUN:
        # verify_dcr() registers a real OAuth client against the team endpoint,
        # which is a write — skip it rather than make a "dry" run leave traces.
        print("\nSkipping DCR verify (dry run).")
        print("Healthy /mcp probe:")
        probe_mcp_health()
        return 0

    print("\nVerifying Cursor desktop DCR set…")
    ok = verify_dcr()
    print("\nHealthy /mcp probe:")
    probe_mcp_health()
    print(
        "\nJon: Cursor Settings → Tools & MCP → openseo → Reload / Authenticate "
        "as support@niceapp.ai → Allow. Close stranded Cloudflare-bindings "
        "localhost:8787 tabs (wrong server). Then agent re-smokes list_projects."
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
