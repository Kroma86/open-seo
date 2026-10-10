# Agent guidance

## Engineering principles

- Prefer simple, readable, flat code with minimal indirection.
- Search for existing implementations and installed libraries before creating new helpers or abstractions.
- Abstract when it prevents meaningful drift and makes the result simpler to maintain. Avoid speculative or one-use abstraction layers.
- Keep product data normalized and relationships explicit. Do not encode relational data in JSON or text merely to avoid joins.
- For new application-backed backend functionality, default to: TanStack server function → service → repository.
- Keep schema changes, queries, and mutations compatible with both SQLite and Postgres.
- Use idiomatic TypeScript. Use Zod to validate untrusted data and narrow runtime values at trust boundaries.
- Prefer established project helpers and libraries over hand-rolled implementations.
- Prefer idiomatic TanStack Query, Router, and Form patterns for server state, routing, and submitted forms.

## Testing

- Don't add tests just for the sake of it. A test exists to enforce core behavior or a hard-to-spot edge case that could actually occur.
- Keep tests as simple as possible, and always review them looking for simplifications.
- Test behavior at the public entry point. Assert argument forwarding to a mocked collaborator only when that mapping is the contract (billing params, telemetry events).
- Statically import the module under test. `vi.mock` is hoisted, so per-test `await import()` and `vi.resetModules()` are banned unless module-level state must reset — comment why.
- Never re-declare a production class in a test. Import the real one; if the module is too heavy to import, move the class to a leaf module first (see `ga4Errors.ts`, `gscErrors.ts`).
- `beforeEach` sets default mock return values only. Vitest's `clearMocks` already resets call state — no `mockReset`/`mockClear` ceremonies.
- Fixtures contain only the fields the test asserts on or the types require. Shared shapes get a factory with overrides (see `ga4-test-fixtures.ts`, `tool-test-support.ts`); a fixture longer than its test's assertions is a smell.
- One test per invariant. Don't re-test Zod or a library, and don't repeat an output-schema round-trip in every happy path.
- Don't mock ORM builder chains. Test repositories through services or real SQL evaluation; chain mocks break on refactors that change no behavior.

### Prove the test can fail

- A test guarding something that reaches production must be **proven to fail when that thing is broken**. Break the code, run the test, see red, restore. It costs two minutes and it is the only check that catches a vacuous test.
- `otto-output-schemas.test.ts` originally shipped green against the exact bug it existed to catch. It validated with `z.object(shape).safeParse(payload)`, and zod's default object mode is *strip* — unknown keys are silently removed, so undeclared fields never raise. Validate through the real path (`normalizeObjectSchema` -> `toJsonSchemaCompat` -> `AjvJsonSchemaValidator`), never an approximation of it.
- Where a suite guards an invariant that can rot silently, carry an explicit non-vacuity block. See `describe("the check above is not vacuous")` in `otto-output-schemas.test.ts`, `scripts/alchemy-state-health.test.mjs` and `scripts/repair-alchemy-state.test.mjs`.
- Declare the environment a test depends on instead of inheriting a default. `oauth-refresh.e2e.test.ts` went stale unnoticed because `getAuthMode()` fail-closes to `cloudflare_access` when `AUTH_MODE` is unset, while the tests pin the hosted Better Auth flow.
- The same rule applies to a green deploy or a passing smoke check: state what would have made it fail. If nothing would have, it proved nothing.

## Log papercuts

When small, non-blocking repository friction occurs—a retried tool call, confusing setup step, flaky command, stale cache, misleading error, or non-obvious gotcha—use the `papercuts` skill and append it to `.agents/PAPERCUTS.md` in the moment. Continue the current task. Real bugs and tracked work are not papercuts, and sensitive data must never be logged.

Do not mine an entire session for papercuts or start a broad cleanup unless the user explicitly asks.

## Preserve review learnings

After a merge-ready or other code review verifies a finding, use `maintain-greptile-rules` only when the finding exposes a recurring or high-risk repository invariant that existing `.greptile/` context and automated checks do not capture. Do not promote one-off bugs or preferences into permanent review rules.

Changes to `.greptile/**`, `AGENTS.md`, `CLAUDE.md`, `.agents/skills/**`, and `.github/**` alter the review control plane and must receive explicit maintainer review. CODEOWNERS requests that review; where repository settings allow, enable GitHub's requirement for code-owner approval. Repository-specific rules live in `.greptile/`; maintainers should configure or retain a minimal org-enforced Greptile baseline for external-contribution, secret, authentication, billing, CI, and rule-tampering risks. Agents should report an unverified or missing baseline and must not mutate dashboard or organization rules without explicit user authorization.
