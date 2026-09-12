#!/usr/bin/env python3
"""Re-enable Cloudflare Access Managed OAuth + Cursor callbacks (merge, never wipe).

Alchemy's Access.Application resource does not pass oauth_configuration, so a
drift-sync PUT can turn Managed OAuth OFF and drop allowed_uris. Run this after
a selfhost deploy if Cursor/Claude/Codex MCP auth fails with:

  redirect_uri is not allowed by the account configuration

IMPORTANT: This script MERGES required URIs into existing allowed_uris. It must
never replace the list with a single Agents HTTPS callback (that broke desktop
Cursor DCR on 2026-09-12 after deploy).

Uses ~/.alchemy/credentials/default/cf-oauth.json (refreshes if needed).
Defaults to BOTH NiceSEO selfhost Access apps (host + /mcp).
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
# Host + path-scoped /mcp — Cursor DCR can hit either depending on discovery.
DEFAULT_APP_IDS = (
    "844fa8f4-e4d5-46e7-8db8-61b93b6b582c",  # seo.niceseo.ai
    "b490d2fe-08b6-4e43-89a5-d2946d2ad6b1",  # seo.niceseo.ai/mcp
)
# Cursor 3.20 DCR registers these together — all must be allow-listed.
REQUIRED_URIS = [
    "https://www.cursor.com/agents/mcp/oauth/callback",
    "https://www.cursor.com/bot/mcp/oauth/callback",
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "http://localhost:8787/callback",
    "grokbot://mcp/oauth/callback",
]
OAUTH_CLIENT_ID = "6d8c2255-0773-45f6-b376-2914632e6f91"
OAUTH_REDIRECT_URI = "http://localhost:9976/auth/callback"
CRED_PATH = Path.home() / ".alchemy/credentials/default/cf-oauth.json"
UA = "Mozilla/5.0 (compatible; openseo-managed-oauth-restore/1.2)"


def app_ids() -> list[str]:
    raw = os.environ.get("OPENSEO_ACCESS_APP_IDS") or os.environ.get(
        "OPENSEO_ACCESS_APP_ID"
    )
    if raw:
        return [p.strip() for p in raw.split(",") if p.strip()]
    return list(DEFAULT_APP_IDS)


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


def merge_uris(existing: list[str]) -> list[str]:
    out: list[str] = []
    for u in list(existing) + REQUIRED_URIS:
        if u not in out:
            out.append(u)
    return out


def restore_app(token: str, app_id: str) -> None:
    try:
        app = api(token, "GET", f"/accounts/{ACCOUNT_ID}/access/apps/{app_id}")[
            "result"
        ]
    except urllib.error.HTTPError as err:
        if err.code != 401:
            raise
        raise  # caller refreshes

    print("app:", app.get("name"), app.get("domain"))
    before = (
        (app.get("oauth_configuration") or {})
        .get("dynamic_client_registration", {})
        .get("allowed_uris")
        or []
    )
    print("before:", json.dumps(before))
    merged = merge_uris(list(before))

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
                    "allowed_uris": merged,
                },
            },
        }.items()
        if v is not None
    }
    updated = api(token, "PUT", f"/accounts/{ACCOUNT_ID}/access/apps/{app_id}", body)
    after = (
        (updated["result"].get("oauth_configuration") or {})
        .get("dynamic_client_registration", {})
        .get("allowed_uris")
    )
    print("put success:", updated.get("success"))
    print("after:", json.dumps(after))
    missing = [u for u in REQUIRED_URIS if u not in (after or [])]
    if missing:
        raise SystemExit(f"restore incomplete for {app_id}: missing {missing}")


def main() -> int:
    creds = load_creds()
    if int(creds.get("expires") or 0) < int(time.time() * 1000) + 300_000:
        print("refreshing alchemy Cloudflare OAuth credentials…")
        creds = refresh(creds)

    token = creds["access"]
    for app_id in app_ids():
        try:
            restore_app(token, app_id)
        except urllib.error.HTTPError as err:
            if err.code != 401:
                raise
            print("access token rejected; refreshing…")
            creds = refresh(creds)
            token = creds["access"]
            restore_app(token, app_id)

    print(
        "\nMerged required callbacks on host + /mcp apps.\n"
        "Jon: one Cursor Allow on openseo if tools still needAuth, then smoke list_projects."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
