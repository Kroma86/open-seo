#!/usr/bin/env python3
"""One-off D1 migration: refresh two seeded Sam-loop prompts (house-only line removed).

Background: per-loop tool capabilities key on the loop's STORED customPrompt
byte-matching an approved template (src/server/features/sam-loops/services/
loopToolFilter.ts). The "On-page priorities" and "Keyword portfolio" template
prompts changed on 2026-09-04 — the "Run only for niceseo.ai, twa.studio, or
niceapp.ai … house-domains-only" sentence was dropped when loops opened to
all clients — so seeded loops still holding the OLD prompt text would
silently degrade to read-only (readers only, warn-logged) on the next deploy.

This migration strips the old opening sentence from the STORED prompt, but
ONLY where the stored prompt still begins with the exact old prefix — i.e.
loops that were seeded and never edited. User-edited prompts are never
touched: those loops have already left the template family (the
reserved-prompt rules + template-family carve-out in SamLoopService govern
them), and editing them blindly could destroy a user's customization.

Run ONCE by an operator, by hand, at deploy time:

    python3 scripts/sam-loop-prompt-refresh-20260904.py            # dry-run (default)
    python3 scripts/sam-loop-prompt-refresh-20260904.py --write    # actually write
    python3 scripts/sam-loop-prompt-refresh-20260904.py --verify   # prove idempotency

Targets Cloudflare D1 `open-seo-db-selfhost` via the REST query API.
Credentials come from the environment only — CF_API_KEY + CF_EMAIL — and are
never printed, logged, or hardcoded. Idempotent: a second run matches nothing
(the prefix is gone), which is what --verify proves.
"""

import argparse
import json
import os
import sys
import urllib.request

ACCOUNT_ID = "9e03005588cee6cae23a89b800c2beb3"
DATABASE_ID = "1edd209b-d21c-4c2a-a948-932c3f6b75de"
API_URL = (
    f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
    f"/d1/database/{DATABASE_ID}/query"
)

# The exact sentence (+ following blank line) removed from the two template
# prompts. Pure ASCII, so Python len() equals SQLite's character count.
OLD_PREFIX = (
    "Run only for niceseo.ai, twa.studio, or niceapp.ai. Other domains: "
    "stop and say this loop is house-domains-only.\n\n"
)
LOOP_NAMES = ("On-page priorities", "Keyword portfolio")
# SQLite SUBSTR is 1-indexed: the new text starts one character past the prefix.
# The offset math assumes pure ASCII (Python len == SQLite character count) —
# guard it: a future edit adding a non-ASCII character (the templates contain
# em/en dashes elsewhere) must fail loudly here, never corrupt a prompt.
assert OLD_PREFIX.isascii(), "OLD_PREFIX must stay pure ASCII (SUBSTR offset math)"
STRIP_OFFSET = len(OLD_PREFIX) + 1


def d1_query(sql: str):
    """POST one statement to the D1 query API; return its result rows."""
    api_key = os.environ.get("CF_API_KEY")
    email = os.environ.get("CF_EMAIL")
    if not api_key or not email:
        sys.exit("CF_API_KEY and CF_EMAIL must be set in the environment.")
    req = urllib.request.Request(
        API_URL,
        data=json.dumps({"sql": sql}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Auth-Key": api_key,
            "X-Auth-Email": email,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not payload.get("success"):
        raise RuntimeError(f"D1 query failed: {payload.get('errors')}")
    result = payload.get("result") or []
    if not result or not result[0].get("success", True):
        raise RuntimeError(f"D1 statement failed: {result}")
    return result[0].get("results") or []


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


NAMES_IN = f"({', '.join(sql_quote(n) for n in LOOP_NAMES)})"
# LIKE has no wildcards to escape in the prefix itself (no % or _).
MATCH_WHERE = (
    f"name IN {NAMES_IN} AND custom_prompt LIKE {sql_quote(OLD_PREFIX + '%')}"
)

COUNT_STALE_SQL = (
    f"SELECT name, COUNT(*) AS n FROM sam_loops WHERE {MATCH_WHERE} GROUP BY name"
)
COUNT_ALL_SQL = (
    f"SELECT name, COUNT(*) AS n FROM sam_loops WHERE name IN {NAMES_IN} GROUP BY name"
)
UPDATE_SQL = (
    f"UPDATE sam_loops SET custom_prompt = SUBSTR(custom_prompt, {STRIP_OFFSET}) "
    f"WHERE {MATCH_WHERE}"
)
REMAINING_SQL = f"SELECT COUNT(*) AS n FROM sam_loops WHERE {MATCH_WHERE}"
# Informational: loops of these names that match NEITHER the old prefix NOR
# the new openings — user-edited or otherwise customized; untouched by design.
# NOTE: these two literals must byte-match the current template openings in
# src/shared/sam-loops.ts (DEFAULT_SAM_LOOP_TEMPLATES). If a template opening
# changes, update them here — otherwise this query silently reclassifies
# seeded loops as "customized" (informational output only, but misleading).
CUSTOMIZED_SQL = (
    f"SELECT name, COUNT(*) AS n FROM sam_loops WHERE name IN {NAMES_IN} "
    f"AND custom_prompt NOT LIKE {sql_quote(OLD_PREFIX + '%')} "
    f"AND custom_prompt NOT LIKE 'The scheduler only has weekly%' "
    f"AND custom_prompt NOT LIKE 'Analyze keyword portfolio%' "
    f"GROUP BY name"
)


def report(title: str, rows) -> None:
    print(title)
    if not rows:
        print("  (none)")
    for row in rows:
        print(f"  {row.get('name')}: {row.get('n')}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="apply the update")
    mode.add_argument(
        "--verify",
        action="store_true",
        help="exit non-zero unless a --write run would change nothing",
    )
    args = parser.parse_args()

    total_stale = sum(r.get("n", 0) for r in d1_query(COUNT_STALE_SQL))

    if args.verify:
        if total_stale != 0:
            print(f"VERIFY FAILED: {total_stale} loop(s) still carry the old prompt prefix.")
            sys.exit(1)
        print("VERIFY OK: no seeded loop carries the old prompt prefix — the migration is idempotent.")
        return

    report("Loops of these names (all):", d1_query(COUNT_ALL_SQL))
    report("Seeded loops still holding the OLD prompt (would be updated):", d1_query(COUNT_STALE_SQL))
    report("Loops with user-edited prompts (untouched, informational):", d1_query(CUSTOMIZED_SQL))

    if not args.write:
        print("\nDry-run. Statement that --write would run:")
        print(f"  {UPDATE_SQL}")
        print("\nRe-run with --write to apply, then --verify to prove idempotency.")
        return

    print(f"\nApplying to {total_stale} loop(s)…")
    d1_query(UPDATE_SQL)
    remaining = d1_query(REMAINING_SQL)[0].get("n", 0)
    print(f"Remaining loops with the old prefix after write: {remaining}")
    if remaining != 0:
        sys.exit("WRITE INCOMPLETE — investigate before re-running.")
    print("Done. Re-seeding is NOT needed; stored prompts now byte-match the new templates.")


if __name__ == "__main__":
    main()
