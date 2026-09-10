#!/usr/bin/env python3
"""Re-enable Cloudflare Access Managed OAuth + Cursor HTTPS callbacks.

Alchemy's Access.Application resource does not pass oauth_configuration, so a
drift-sync PUT can turn Managed OAuth OFF and drop allowed_uris. Run this after
a selfhost deploy if Cursor/Claude/Codex MCP auth fails with:

  redirect_uri is not allowed by the account configuration

Uses ~/.alchemy/credentials/default/cf-oauth.json (refreshes if needed).
Defaults to the NiceSEO selfhost Access app on account 9e030055…; override with
OPENSEO_ACCESS_ACCOUNT_ID / OPENSEO_ACCESS_APP_ID.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ACCOUNT_ID = os.environ.get(
    "OPENSEO_ACCESS_ACCOUNT_ID", "9e03005588cee6cae23a89b800c2beb3"
)
APP_ID = os.environ.get(
    "OPENSEO_ACCESS_APP_ID", "844fa8f4-e4d5-46e7-8db8-61b93b6b582c"
)
CURSOR_HTTPS = "https://www.cursor.com/agents/mcp/oauth/callback"
OAUTH_CLIENT_ID = "6d8c2255-0773-45f6-b376-2914632e6f91"
OAUTH_REDIRECT_URI = "http://localhost:9976/auth/callback"
CRED_PATH = Path.home() / ".alchemy/credentials/default/cf-oauth.json"
UA = "Mozilla/5.0 (compatible; openseo-managed-oauth-restore/1.0)"


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


def main() -> int:
    creds = load_creds()
    # Refresh when within 5 minutes of expiry (or already past).
    if int(creds.get("expires") or 0) < int(time.time() * 1000) + 300_000:
        print("refreshing alchemy Cloudflare OAuth credentials…")
        creds = refresh(creds)

    token = creds["access"]
    try:
        app = api(token, "GET", f"/accounts/{ACCOUNT_ID}/access/apps/{APP_ID}")[
            "result"
        ]
    except urllib.error.HTTPError as err:
        if err.code == 401:
            print("access token rejected; refreshing…")
            creds = refresh(creds)
            token = creds["access"]
            app = api(token, "GET", f"/accounts/{ACCOUNT_ID}/access/apps/{APP_ID}")[
                "result"
            ]
        else:
            raise

    print("app:", app.get("name"), app.get("domain"))
    print("before:", json.dumps(app.get("oauth_configuration"), indent=2))

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
            "oauth_configuration": {
                "enabled": True,
                "dynamic_client_registration": {
                    "enabled": True,
                    "allow_any_on_localhost": True,
                    "allow_any_on_loopback": True,
                    "allowed_uris": [CURSOR_HTTPS],
                },
            },
        }.items()
        if v is not None
    }
    updated = api(token, "PUT", f"/accounts/{ACCOUNT_ID}/access/apps/{APP_ID}", body)
    print("put success:", updated.get("success"))
    print(
        "after:",
        json.dumps(updated["result"].get("oauth_configuration"), indent=2),
    )
    print(
        "\nAllowed callbacks:\n"
        f"  - {CURSOR_HTTPS}\n"
        "  - http://localhost:*/callback  (via allow_any_on_localhost)\n"
        "  - http://127.0.0.1:*/callback (via allow_any_on_loopback)\n"
        "Note: cursor:// custom-scheme callbacks cannot be allow-listed on CF.\n"
        "Jon: click AuthenticateMcpServer again in Cursor."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
