// The contract shared by the two email-gated Cloudflare Access boundaries —
// the persistent preview wildcard (alchemy.preview-access.run.ts) and the
// per-stage self-host gate (alchemy.run.ts). Worker naming, the
// WORKERS_SUBDOMAIN shape, the allowed-emails parsing, and the
// policy/application shape define who gets through which hostnames; keep them
// in one place so the two gates cannot drift. The one copy that can't import
// this module is the shell in .github/workflows/pr-preview.yml — its
// `open-seo-<stage>` naming stays comment-synced (and is backstopped by the
// workflow's Access verify step).

import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const WORKER_PREFIX = "open-seo";

// The one stage that adopts openseo.so's live hosted resources (unsuffixed
// names, app.openseo.so domain, Postgres). Deliberately not "prod" so a
// self-hoster's stage name can't collide with the adoption path.
export const HOSTED_PROD_STAGE = "hosted-prod";

export const workerName = (stage: string) =>
  stage === HOSTED_PROD_STAGE ? WORKER_PREFIX : `${WORKER_PREFIX}-${stage}`;

// Matches every preview worker hostname; production's unsuffixed worker does
// not match (Access allows one wildcard per dot-label).
export const previewWildcard = (subdomain: string) =>
  `${WORKER_PREFIX}-*.${subdomain}`;

export const readWorkersSubdomain = ({ required }: { required: boolean }) =>
  Effect.gen(function* () {
    const subdomain = (yield* Config.string("WORKERS_SUBDOMAIN").pipe(
      Config.withDefault(""),
    )).trim();
    if (subdomain.endsWith(".workers.dev") || (!subdomain && !required)) {
      return subdomain;
    }
    return yield* Effect.die(
      new Error(
        `Set WORKERS_SUBDOMAIN to the account's full workers.dev subdomain (shown under Workers & Pages)${required ? "." : ", or leave it unset."}`,
      ),
    );
  });

/** Reads ACCESS_ALLOWED_EMAILS; dies with `remedy` when none are set. */
export const requireAllowedEmails = (remedy: string) =>
  Effect.gen(function* () {
    const emails = (yield* Config.string("ACCESS_ALLOWED_EMAILS").pipe(
      Config.withDefault(""),
    ))
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean);
    if (emails.length === 0) {
      return yield* Effect.die(new Error(remedy));
    }
    return emails;
  });

/**
 * The gate itself: an email allow-policy on a self-hosted Access application.
 *
 * When `internalApiBypass` is set, also provisions a more-specific Access
 * application for `/api/internal` on each hostname with a Bypass (everyone)
 * policy. Cloudflare Access prefers the longest matching path, so browser UI
 * stays email-gated while Hermes can reach machine exports. The Worker still
 * requires `AGENCY_SCORE_EXPORT_TOKEN` on those routes — Access is not the
 * auth for them.
 */
export const emailAccessGate = (options: {
  policyId: string;
  applicationId: string;
  policyName: string;
  applicationName: string;
  /** Primary hostname (also used when destinations are omitted). */
  domain: string;
  /** Extra public hostnames to protect (custom domains). */
  extraDomains?: string[];
  emails: string[];
  /** Machine-export path bypass (self-host only; leave unset for previews). */
  internalApiBypass?: {
    policyId: string;
    applicationId: string;
    policyName: string;
    applicationName: string;
  };
}) =>
  Effect.gen(function* () {
    const allow = yield* Cloudflare.Access.Policy(options.policyId, {
      name: options.policyName,
      decision: "allow",
      include: options.emails.map((email) => ({ email: { email } })),
    });
    const hostnames = [
      options.domain,
      ...(options.extraDomains ?? []),
    ].filter(
      (hostname, index, all) => hostname && all.indexOf(hostname) === index,
    );
    const application = yield* Cloudflare.Access.Application(
      options.applicationId,
      {
        type: "self_hosted",
        name: options.applicationName,
        domain: hostnames[0],
        // 1-month login sessions (Jon 2026-08-31) — set via API that day; kept
        // here so a redeploy doesn't silently reset the app to the 24h default.
        sessionDuration: "730h",
        // Keep workers.dev + custom domain behind the same email allow-list.
        destinations: hostnames.map((uri) => ({
          type: "public" as const,
          uri,
        })),
        policies: [allow.policyId],
      },
    );

    if (options.internalApiBypass) {
      const bypass = yield* Cloudflare.Access.Policy(
        options.internalApiBypass.policyId,
        {
          name: options.internalApiBypass.policyName,
          decision: "bypass",
          include: [{ everyone: {} }],
        },
      );
      // Path-scoped apps beat the hostname-wide gate for /api/internal/*.
      const internalPaths = hostnames.map(
        (hostname) => `${hostname}/api/internal`,
      );
      yield* Cloudflare.Access.Application(
        options.internalApiBypass.applicationId,
        {
          type: "self_hosted",
          name: options.internalApiBypass.applicationName,
          domain: internalPaths[0],
          destinations: internalPaths.map((uri) => ({
            type: "public" as const,
            uri,
          })),
          policies: [bypass.policyId],
        },
      );
    }

    return application;
  });
