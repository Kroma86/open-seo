# Sam loops through the native Grok subscription

This change is opt-in and does not deploy or install anything. The existing
OpenRouter helper remains unchanged. No frontier-model API is used by the
subscription path, and there is no automatic OpenRouter fallback.

## Before activation

1. Keep the Mini timer stopped. Drain old Sam workflows and inspect active runs.
2. Deploy one consistent Worker revision with `SAM_LOOP_EXECUTOR=subscription`.
   This stops both scheduled and manual Worker model starts. Manual requests
   return `disabled`; the external runner handles schedules, not manual clicks.
3. Reuse the existing `AGENCY_SCORE_EXPORT_TOKEN` and Cloudflare Access service
   credentials. Do not create or rotate secrets for this change.
4. Perform an authenticated GET preview and a native Grok dry-run on the Mini.
5. Only after separately authorized activation, enable the runner's `--execute`
   option and its timer. The checked-in service intentionally defaults to dry-run.

## Machine route

`/api/internal/sam-loop-subscription` requires the existing bearer token and
the site's existing Cloudflare Access machine login. Anonymous requests fail.
GET lists due, permitted loops or previews one loop using `projectId` and
`loopId`. GET does not claim, advance schedules, execute tools, or call a model.
Preview access works before activation so dry-runs can be tested safely.

POST accepts strict JSON actions:

- `claim`: observed schedule, project/loop identity, and native model name.
  Admission rechecks permission and the shared daily run cap. Run creation,
  signed-state initialization, and schedule advancement are one transaction.
  Postgres uses the same admission lock as existing runs. D1 uses one atomic
  raw batch through the shared database helper.
- `tool`: run identity, signed receipt, next step, tool name and arguments.
  Only the shared scoped loop tools are exposed, minus the two paid business
  profile/review readers. Tool inputs are validated, then the step is consumed
  before execution. A consumed step cannot be replayed.
- `complete`: final report plus the latest signed receipt. The shared report
  and monthly article checks run against server-signed tool inputs and results.
  A model cannot supply its own proof of a saved topic or read page.
- `fail`: bounded failure reason for an admitted subscription run. Already
  recorded proposal counts are preserved. Unknown proposal outcomes hold later
  runs until an operator inspects them; failure does not erase that hold.

Each report is stored in `sam_loop_runs` with actual status, steps and proposal
count. Terminal cost notes say `subscription` and `model API cost $0`; existing
non-model tool billing is unchanged. This is not a claim of unlimited free
subscription usage. No database migration or new secret is required.

## Limits and recovery

Each run has 24 tool steps, 15 minutes, a 700,000-byte signed-evidence limit,
and a 1,200,000-byte POST body limit. The runner kills the native process when
its remaining time expires. Existing tool adapters do not all honor cancellation;
the server consumes the step first and refuses late completion rather than
claiming every remote tool can be forcibly stopped.

The signing receipt lives with the runner; only its current hash is stored on
an active run. Intermediate private tool results are not published as reports.
Completed/failed reports are immutable through this route.

Do not replay a lost claim, tool, or completion reply. A pending proposal may
have happened even when no reply arrived. Inspect its actual queue and run
record before any recovery. There is no reset/force-retry endpoint.

Rollback is not permission to invoke OpenRouter. Stop the timer, inspect all
active/held subscription runs, and keep scheduled generation disabled until an
approved replacement executor is selected. The legacy source is retained only
for compatibility; removing the flag alone restores the old Worker behavior.

The Python runner and uninstalled service/timer are in the companion Agentic OS
change under `projects/ops-grok-bot/sam-loops-grok/`.
