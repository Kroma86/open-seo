#!/usr/bin/env python3
"""One-off D1 migration: seed 3 new Sam loops + stagger loop schedules.

Delivered 2026-09-03, intended to be run ONCE by an operator, by hand:

    python3 scripts/sam-loop-stagger-20260903.py            # dry-run (default)
    python3 scripts/sam-loop-stagger-20260903.py --write    # actually write
    python3 scripts/sam-loop-stagger-20260903.py --verify   # prove idempotency

Targets Cloudflare D1 `open-seo-db-selfhost` via the REST query API.
Credentials come from the environment only — CF_API_KEY + CF_EMAIL — and are
never printed, logged, or hardcoded.

What it does:
  a. Prints the live sam_loops schema (SELECT from sqlite_master).
  b. INSERTs the 3 new custom loops (Review watch / GBP drift /
     CTR opportunities) for every non-archived project, idempotent on
     (project_id, name) via INSERT ... SELECT ... WHERE NOT EXISTS, using the
     same column set as the app's ensureDefaultLoops.
  c. UPDATEs next_run_at for EXISTING loops (all names).

  Inserts and updates use ONE rule, shared with the app's seeded
  computeNextSamLoopRunAt (src/shared/sam-loops.ts), so the migration and
  the app advance never fight over a loop's date:
    weekly  → the next occurrence of the loop's assigned weekday
              (FNV-1a(`${projectId}:${loopName}`) % 7, 0 = Monday ... 6 =
              Sunday), counting from today;
    monthly → the loop's assigned month-day (1 + hash%28) in the current
              month, rolling to the following month when that moment has
              passed;
  Time-of-day: inserts use hour 4-9 UTC + minute derived from the hash
  (instead of the app's Math.random — an intentional, documented deviation:
  the script must be deterministic so re-runs are idempotent; the 4-9 UTC
  window is preserved). Updates PRESERVE each loop's current
  hour/minute/second. If a result would land in the past (assigned day is
  today but the time has gone), one full interval is added. Daily loops are
  left untouched (the spread rule has no date component for daily and the
  time-of-day is preserved, so there is nothing to change). Loops whose
  next_run_at is in the past are never touched — they reschedule naturally
  on the next scheduler tick (the app's advance path re-spreads stale
  anchors with the same rule).
  d. Prints a FULL distribution report BEFORE any write covering ALL loops —
     planned inserts, planned updates, untouched past-due (counted on today,
     they run at the next tick), untouched daily (counted every day), and
     unchanged loops (counted at their current date): weekly loops per
     weekday, monthly loops per month-day, and the projected busiest day in
     the next 28 days. --write prints each statement's outcome as it runs.
     --verify recomputes the plan and exits non-zero unless it is empty
     (proof that a second --write would change nothing).
"""

import argparse
import json
import os
import sys
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

ACCOUNT_ID = "9e03005588cee6cae23a89b800c2beb3"
DATABASE_ID = "1edd209b-d21c-4c2a-a948-932c3f6b75de"
API_URL = (
    f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
    f"/d1/database/{DATABASE_ID}/query"
)

NEW_LOOPS = [
    {
        "name": "Review watch",
        "cadence": "weekly",
        "custom_prompt": (
            "You run weekly for every client. Read-only: never queue fixes, never post anything anywhere, never buy paid research beyond the single review collection described here.\n"
            "1. get_niceseo_ops_status for context.\n"
            "2. get_business_reviews for this project's business. If a collection is already running, wait for the taskId to finish instead of starting a second one. If reviews cannot be fetched, say \"not measured\" and stop.\n"
            "3. List reviews from the last 7 days: author, star rating, date, whether the owner replied.\n"
            "4. Flag any review at 3 stars or lower without an owner reply as NEEDS A REPLY, with a one-sentence suggested reply the owner can edit (never post it).\n"
            "5. If there are no new reviews, say so plainly and stop — a quiet week is a good report, keep it to two sentences.\n"
            "Report: new reviews count, average rating this week, the NEEDS A REPLY list, and one praise-worthy quote when one exists. Plain English the owner can read in Slack."
        ),
    },
    {
        "name": "GBP drift",
        "cadence": "monthly",
        "custom_prompt": (
            "You run monthly for every client. Read-only: never queue fixes, never post anywhere.\n"
            "1. get_business_profile for this project's business. If it cannot be fetched, say \"not measured\" and stop.\n"
            "2. Compare against the values from your last completed run (call get_sam_loop_runs for this project and read your previous report). First run: record the current values and say \"baseline recorded\".\n"
            "3. Report only CHANGES: business hours, phone number, categories, description, website link. For each change: old value → new value, and whether it looks intentional (e.g. holiday hours) or suspicious (e.g. phone number changed with no other edit).\n"
            "4. If nothing changed, one line: \"Profile unchanged since <date>.\"\n"
            "Never invent a previous value. When unsure, say not measured."
        ),
    },
    {
        "name": "CTR opportunities",
        "cadence": "monthly",
        "custom_prompt": (
            "You run monthly for every client. You may only propose title and description fixes (pending only, never published). Never propose H1, schema, og tags, canonicals, or content. Never buy paid research.\n"
            "1. get_search_console_performance for this project (query+page rows, high rowLimit). If Search Console is not connected, say \"not measured\" and stop.\n"
            "2. From the last 28 days, find up to 3 queries with: position 5–20, impressions ≥ 30, and CTR ≤ 1%. Rank them by impressions.\n"
            "3. For each: identify the ranking page, read its current title and description (get_agency_otto_page_inputs), and draft a replacement title (≤60 chars) and description (≤155 chars) that matches the query's intent using only facts from the page. No invented claims, no clickbait.\n"
            "4. Call propose_homegrown_otto_fixes with status pending for title and description only, copying before_* from the page inputs. List the proposal ids.\n"
            "5. If nothing qualifies, say so in one sentence — that is a good report.\n"
            "Report: the query, its position/impressions/CTR, the page, and the proposed new title/description. Never claim a fix is live."
        ),
    },
]


def fnv1a_32(seed: str) -> int:
    """FNV-1a 32-bit, identical to fnv1a32 in src/shared/sam-loops.ts."""
    h = 0x811C9DC5
    for b in seed.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def spread_offset_days(seed: str, cadence: str) -> int:
    """Mirror of samLoopSpreadOffsetDays (weekly → %7, monthly → %28)."""
    return fnv1a_32(seed) % (7 if cadence == "weekly" else 28)


def spread_time_parts(seed: str):
    """Hour 4-9 UTC and minute derived from the hash (new inserts only)."""
    h = fnv1a_32(seed)
    return 4 + (h % 6), (h >> 8) % 60


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def parse_stored(value: str) -> datetime:
    """Parse ISO ('T', 'Z', millis) or sqlite (' ') timestamps as UTC."""
    text = value.strip().replace(" ", "T").replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


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


def new_loop_next_run_at(project_id: str, loop: dict, now: datetime) -> datetime:
    """Same single rule as the app's seeded computeNextSamLoopRunAt:
    weekly → next occurrence of the assigned weekday (hash%7, 0 = Monday)
    from today; monthly → assigned month-day (1 + hash%28) this month,
    rolling to next month when past. Hour/minute from the hash (deterministic
    stand-in for the app's Math.random; same 4-9 UTC window)."""
    seed = f"{project_id}:{loop['name']}"
    h = fnv1a_32(seed)
    hour, minute = spread_time_parts(seed)
    if loop["cadence"] == "weekly":
        days_ahead = ((h % 7) - now.weekday()) % 7
        candidate = (now + timedelta(days=days_ahead)).replace(
            hour=hour, minute=minute, second=0, microsecond=0
        )
        if candidate <= now:
            candidate += timedelta(days=7)
        return candidate
    assigned_day = 1 + (h % 28)
    candidate = now.replace(
        day=assigned_day, hour=hour, minute=minute, second=0, microsecond=0
    )
    if candidate <= now:
        if now.month == 12:
            candidate = candidate.replace(year=now.year + 1, month=1)
        else:
            candidate = candidate.replace(month=now.month + 1)
    return candidate


def spread_existing(loop: dict, now: datetime):
    """Deterministic current-period target for an existing loop, or None.

    Returns None for daily loops, loops without next_run_at, past-due loops,
    and loops already on their target (idempotent second run).
    """
    current_raw = loop.get("next_run_at")
    cadence = loop.get("cadence")
    if not current_raw or cadence == "daily":
        return None
    current = parse_stored(current_raw)
    if current < now:
        return None  # past-due loops reschedule naturally
    seed = f"{loop['project_id']}:{loop['name']}"
    keep = {"hour": current.hour, "minute": current.minute,
            "second": current.second, "microsecond": 0}
    if cadence == "weekly":
        assigned = spread_offset_days(seed, "weekly")  # 0 = Monday
        days_ahead = (assigned - now.weekday()) % 7
        candidate = (now + timedelta(days=days_ahead)).replace(**keep)
        if candidate <= now:
            candidate += timedelta(days=7)
    else:  # monthly
        assigned_day = 1 + spread_offset_days(seed, "monthly")
        candidate = now.replace(day=assigned_day, **keep)
        if candidate <= now:
            if now.month == 12:
                candidate = candidate.replace(year=now.year + 1, month=1)
            else:
                candidate = candidate.replace(month=now.month + 1)
    if iso_z(candidate) == iso_z(current):
        return None
    return candidate


def build_plan(projects, loops, now):
    """Compute inserts, updates, and the projected post-migration schedule.

    Returns (inserts, updates, counts, projected) where projected is a list
    of (datetime, cadence) for EVERY loop that will run after the migration
    — changed or not — so the distribution report reflects the true load.
    """
    existing_pairs = {(l["project_id"], l["name"]) for l in loops}

    inserts = []  # (sql, project_id, loop, next_run_at)
    already_present = 0
    projected = []  # (datetime, cadence)
    for project in projects:
        pid = project["id"]
        for loop in NEW_LOOPS:
            if (pid, loop["name"]) in existing_pairs:
                already_present += 1
                continue
            next_at = new_loop_next_run_at(pid, loop, now)
            sql = (
                "INSERT INTO sam_loops (id, project_id, name, source_type, "
                "skill_name, custom_prompt, cadence, is_enabled, next_run_at)\n"
                f"SELECT {sql_quote(str(uuid.uuid4()))}, {sql_quote(pid)}, "
                f"{sql_quote(loop['name'])}, 'custom', NULL, "
                f"{sql_quote(loop['custom_prompt'])}, "
                f"{sql_quote(loop['cadence'])}, 1, {sql_quote(iso_z(next_at))}\n"
                f"WHERE NOT EXISTS (SELECT 1 FROM sam_loops "
                f"WHERE project_id = {sql_quote(pid)} "
                f"AND name = {sql_quote(loop['name'])})"
            )
            inserts.append((sql, pid, loop, next_at))
            projected.append((next_at, loop["cadence"]))

    updates = []  # (sql, loop, next_run_at)
    skipped_past_due = 0
    skipped_daily = 0
    skipped_unscheduled = 0
    skipped_on_target = 0
    for loop in loops:
        current_raw = loop.get("next_run_at")
        cadence = loop.get("cadence")
        if cadence == "daily":
            skipped_daily += 1
            if current_raw:
                try:
                    projected.append((parse_stored(current_raw), cadence))
                except ValueError:
                    pass
            continue
        if not current_raw:
            skipped_unscheduled += 1
            continue
        try:
            current = parse_stored(current_raw)
        except ValueError:
            skipped_unscheduled += 1
            continue
        if current < now:
            skipped_past_due += 1
            # Runs at the next scheduler tick, i.e. today.
            projected.append((now, cadence))
            continue
        candidate = spread_existing(loop, now)
        if candidate is None:
            skipped_on_target += 1
            projected.append((current, cadence))
            continue
        sql = (
            f"UPDATE sam_loops SET next_run_at = {sql_quote(iso_z(candidate))} "
            f"WHERE id = {sql_quote(loop['id'])}"
        )
        updates.append((sql, loop, candidate))
        projected.append((candidate, cadence))

    counts = {
        "already_present": already_present,
        "past_due": skipped_past_due,
        "daily": skipped_daily,
        "unscheduled": skipped_unscheduled,
        "on_target": skipped_on_target,
    }
    return inserts, updates, counts, projected


def print_distribution(inserts, updates, counts, projected, now):
    """Full post-migration load: ALL loops, changed or not."""
    weekly_days = {}
    monthly_days = {}
    daily_count = 0
    window_end = now + timedelta(days=28)
    per_date = {}

    for when, cadence in projected:
        if cadence == "daily":
            daily_count += 1
            day = now.replace(hour=0, minute=0, second=0, microsecond=0)
            while day < window_end:
                per_date[day.date()] = per_date.get(day.date(), 0) + 1
                day += timedelta(days=1)
        elif cadence == "weekly":
            key = when.strftime("%A")
            weekly_days[key] = weekly_days.get(key, 0) + 1
            occ = when
            while occ < window_end:
                per_date[occ.date()] = per_date.get(occ.date(), 0) + 1
                occ += timedelta(days=7)
        else:  # monthly
            monthly_days[when.day] = monthly_days.get(when.day, 0) + 1
            if now <= when < window_end:
                per_date[when.date()] = per_date.get(when.date(), 0) + 1

    weekday_order = [
        "Monday", "Tuesday", "Wednesday", "Thursday",
        "Friday", "Saturday", "Sunday",
    ]
    print("=== Distribution after this migration (ALL loops, projected) ===")
    print("Weekly loops per weekday:")
    for day in weekday_order:
        if day in weekly_days:
            print(f"  {day:<9} {weekly_days[day]}")
    print("Monthly loops per month-day:")
    for day in sorted(monthly_days):
        print(f"  day {day:>2}   {monthly_days[day]}")
    print(f"Daily loops: {daily_count} (run every day)")
    if per_date:
        busiest = max(per_date.items(), key=lambda kv: kv[1])
        print(
            f"Projected busiest day in the next 28 days: "
            f"{busiest[0]} with {busiest[1]} loop runs"
        )
    print()

    print("=== Planned changes ===")
    print(f"  inserts (new loops):        {len(inserts)}")
    print(f"  already present (skipped):  {counts['already_present']}")
    print(f"  updates (existing loops):   {len(updates)}")
    print(f"  already on target:          {counts['on_target']}")
    print(f"  past-due (never touched):   {counts['past_due']}")
    print(f"  daily (never touched):      {counts['daily']}")
    print(f"  unscheduled / unparsable:   {counts['unscheduled']}")
    print()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--write",
        action="store_true",
        help="Execute the writes. Default is a read-only dry-run.",
    )
    mode.add_argument(
        "--verify",
        action="store_true",
        help="Recompute the plan and fail unless it is empty (idempotency).",
    )
    args = parser.parse_args()
    now = datetime.now(timezone.utc)

    # a. Schema first.
    schema_rows = d1_query(
        "SELECT sql FROM sqlite_master WHERE name='sam_loops'"
    )
    print("=== sam_loops schema ===")
    for row in schema_rows:
        print(row.get("sql", ""))
    print()

    projects = d1_query("SELECT id FROM projects WHERE archived_at IS NULL")
    loops = d1_query(
        "SELECT id, project_id, name, cadence, next_run_at FROM sam_loops"
    )
    print(
        f"Found {len(projects)} non-archived projects, "
        f"{len(loops)} existing loops.\n"
    )

    inserts, updates, counts, projected = build_plan(projects, loops, now)
    print_distribution(inserts, updates, counts, projected, now)

    if args.verify:
        if not inserts and not updates:
            print(
                "VERIFY OK — plan is empty; a second --write would change "
                "nothing (idempotent)."
            )
            return
        print(
            f"VERIFY FAILED — {len(inserts)} inserts and {len(updates)} "
            "updates would still run."
        )
        sys.exit(1)

    if not args.write:
        print("DRY-RUN — nothing written. Re-run with --write to apply.")
        return

    print("=== Writing ===")
    ok = 0
    for sql, pid, loop, next_at in inserts:
        d1_query(sql)
        ok += 1
        print(f"  inserted  {loop['name']:<18} project={pid} next={iso_z(next_at)}")
    for sql, loop, candidate in updates:
        d1_query(sql)
        ok += 1
        print(
            f"  updated   {loop['name']:<18} project={loop['project_id']} "
            f"next={iso_z(candidate)} (was {loop['next_run_at']})"
        )
    print(f"Done — {ok} statements executed.")


if __name__ == "__main__":
    main()
