# Measurement v2 (draft, no production activation)

This is a separate stored-data lane. `MEASUREMENT_V2.enabled` is false and
`dryRun` is true. `spendBoundVerified` is false. The existing weekly settings, prompts and schedule are unchanged.
The existing five-minute invocation calls this lane after existing jobs.

## Activation gates

Do not activate from this PR alone. None of the five candidate projects has been
verified in this implementation session against frozen-lane truth, current holds,
the never-client list or live OpenSEO Context. No enrollment or question rows are
seeded. Missing evidence refuses work. The two spare projects are not enrolled;
a substitution requires another reviewed allowlist change. The excluded domain
cannot be enrolled.

Before a separately approved activation, an owner must record exactly five
allowlisted enrollment rows with their existing config IDs. Each receipt contains
projectId, domain, frozenLaneAllowed:true, held:false, neverClient:false, the
immutable source reference and verifiedAt. SHA-256 of its exact JSON must match
eligibilityHash. A hash proves the receipt is unchanged, not that its claims are
true; the owner must check the original source. Evidence must be at most one day
old at pilot start. The pilot expires seven days after startsAt, not after each poll.

contextHash covers JSON.stringify({sections, customSections, keyPages}), sorted
by section key, custom slug and page ID respectively, using getProjectContext.
The business overview must exist. This makes changed or missing Context a hold.
Matching uses the current config brand and enrolled project domain; third-party
Context page hosts are never assumed to be client-owned.

Store ten existing active prompts in measurement_questions, with kind `active`.
Reserve at most five additional existing prompt IDs with kind `approved_context`
and owner approval evidence for the Context service/town question. This code does
not write questions, activate prompts or infer approval. Prompt text must still
match its source config. Changing the stored set, Context, brand, eligibility,
location or language invalidates the dry-run fingerprint.

First run enabled:true/dryRun:true. It checks eligibility and logs only counts
and credit estimates, writes dryRunAt/dryRunHash, and posts no tasks. Only a later
reviewed change to dryRun:false can post. No activation tool is exposed.

## Queue and accounting

Official documentation read with the read-only DataForSEO docs tool, 2026-11-13:

- https://docs.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/task_post/
- https://docs.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/task_get/advanced/
- https://docs.dataforseo.com/v3/serp/google/ai_mode/task_post/
- https://docs.dataforseo.com/v3/serp/google/ai_mode/task_get/advanced/

Posts use normal priority 1, keyword, location_code, language_code and tag; the
ChatGPT scraper also uses force_web_search:true. No live endpoint, callback or
high-priority request is used. The SDK task clients disable HTTP retries.
Results are free to retrieve for 30 days. Collection is capped at 20 tasks per
poll, and answers time out after 24 hours. A response with an unknown or missing
shape is unparsed, not a negative result. No uncertain post is replayed.

Each question gets three scraper answers and one AI Mode answer, at most once
per seven-day pilot, and no more than once per UTC week
(starting Monday). Up to 15 questions means 60 answers per client, 300 for five.
The estimate reserves 1.2 raw provider credits per answer with SEO_DATA_COST_MARKUP=1.28 applied
to each engine batch, including in self-hosted mode. Fifteen questions cost
72 raw credits and 92.16 billed credits per client. Five clients cost 360 raw
and 460.8 billed credits. The limits are 108 billed credits/client/week and
540 billed credits total/week, and are never raised. Stored accounting uses
integer hundredths of a billed credit to avoid floating-point cap drift.
One raw credit means $0.001 provider cost. Hosted metering still uses the
existing helper; the independent pilot caps also apply on self-hosted systems.
The public standard price was $0.0012 per task in the design source check; billed
credits at the current rate is an estimate, not a guaranteed maximum provider tariff. The owner must
verify applicable pricing/options before activation. Estimates are logged before
posting, including any estimate over 2,000 credits (the pilot rejects far below
that). An atomic conditional budget UPDATE limits simultaneous reservations.
Consumed or uncertain capacity stays consumed. Costs above reserve halt further
weekly reservations. No account, product, key or balance was tested or changed.

## Reports and statistics

get_ai_visibility_v2_report uses stored rows only, with project authorization.
It returns per-engine question X/N, majority across available repeated answers,
cited X/N, 95% Wilson bands over questions, exclusions and top cited domains.
N below eight says too_few_answers and has no band; N=0 says not_measured.
Errors, timeouts and unparsed answers are excluded separately, never zero-filled.
A citation requires a cited source URL/domain match. Retrieved search_results,
brand entity links and local listings are separate channels and are not citations.
The old-engine comparison requires identical stored prompt text and ID in the
same UTC week and a successful old-engine result; missing comparisons say not
measured. API responses and scraped UI answers remain different measurements.

## Migration and rollout hold

Six additive tables are necessary: enrollment, stored questions, weekly budget,
runs, answers, cited domains. D1 and Postgres definitions are mirrored and guarded
by the existing schema-parity suite. No existing data is rewritten. The generated
migrations are included for review only, not applied. Deployment scripts apply
migrations automatically: Jon's merge/deploy/migration approval is required before
that path. No merge or deployment is authorized in this task. Back up before
applying; rollback code to the previous version and retain the new tables as
inactive evidence rather than deleting observations.

Monthly Gemini/Perplexity remains design only: give each its own labelled engine,
monthly budget and method-specific queued endpoint after official documentation
and product access checks. No endpoint or cost assumption here enables that work.

## PM regression requirements (current agency-platform)

Fetched agency-platform explicitly from niceseo-ai/open-seo on 2026-11-13;
its head is 8bc0733081665ec1fba0738216ee6074c2907c8c, the assigned base.
The existing promptExplorer.ts caches by prompt/model for seven days; existing
runAiVisibilityCheck.ts passes skipCacheRead:true for scheduled measurement.
V2 never calls promptExplorer or reads that cache. Each of its three ChatGPT
repeats gets a fresh answer UUID and a distinct upstream task. The tests collect
different repeat results and assert the cache reader is never called.

measurementPaths.ts guards the actual v2 HTTP clients before credential lookup,
allowing only the two task_post/task_get routes. Tests call real SDK live methods
through those factories and require refusal. The existing ai.ts live routes are
unchanged. The self-hosted regression uses the real metered client with hosted
billing disabled and confirms 540 billed credits blocks all new posts, even
though monthly customer balance checks are bypassed. Raw and billed estimates
and returned costs are logged separately. All four requirements are in the
exact-state review packet.

## Security review repair and unresolved activation hold

Opus 5.5 security round 1 returned CHANGES on the exact initial file manifest.
Repairs accept provider-style hex task IDs instead of standard-only UUIDs;
persist paid task IDs and costs inside the post callback before hosted billing
tracking; keep free collection independent of later spend/Context/plan gates;
use run-time snapshots of brand/domain/config/question; expire malformed queued
rows before skipping them; allow 24 hours to collect; preserve prompt snapshots
when source prompts are deleted; cascade project deletion; and enforce one run
per seven-day enrollment even when that interval crosses Monday. Owner receipt
hashes are explicitly drift checks, not signed proof of the claims.

A receipt write that fails because storage is unavailable remains uncertain work:
its reservation stays consumed and the provider submission is never replayed.
Manual reconciliation may be needed for paid tasks whose IDs could not be saved.

S3 remains an activation blocker. A client-side forecast cannot bind an unknown
provider tariff or guarantee an absolute final charge. No paid probe is authorized
and a probe would itself have an unknown maximum. The code now refuses all live
posts unless spendBoundVerified is separately changed after an enforceable
provider maximum-charge bound has been established. This session has no such
evidence. Do not change that flag or call this lane ready to activate. The fixed
540 billed-credit cap is unchanged; no larger limit or allowance for an extra
batch has been introduced. Expected cost still fits: 300 answers, $0.36 raw,
460.8 billed credits. Tests use only a synthetic verified bound to exercise the
queue and self-hosted cap. No production enrollment or task was created.

Kimi k3.1-pro review was dispatched twice; both completed without assistant text,
executed-model identity or verdict. Neither counts as approval. Opus security is
from the design family and is not being substituted for independent review.
Until a separate-family review can run, this working tree stays uncommitted.
No draft PR, hosted CI, review-thread count or five-minute post-CI wait can be
claimed complete in that state.
