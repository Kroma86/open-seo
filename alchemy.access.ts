// The contract shared by the two email-gated Cloudflare Access boundaries —
// the persistent preview wildcard (alchemy.preview-access.run.ts) and the
// per-stage self-host gate (alchemy.run.ts). Worker naming, the
// WORKERS_SUBDOMAIN shape, the allowed-emails parsing, and the
// policy/application shape define who gets through which hostnames; keep them
// in one place so the two gates cannot drift. The one copy that can't import
// this module is the shell in .github/workflows/pr-preview.yml — its
// `open-seo-<stage>` naming stays comment-synced (and is backstopped by the
// workflow's Access verify step).

import * as Alchemy from "alchemy";
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
 *
 * When `mcpServiceAuth` is set, also provisions a Service Auth (non_identity)
 * policy bound to a named service token on a more-specific `/mcp` application
 * ONLY (whose AUD tag becomes `MCP_POLICY_AUD`). The service-token policy
 * must never attach to the hostname-wide app: there it would mint
 * user-audience JWTs for service tokens and open the user door. Grok Bot and
 * other MCP clients pass `CF-Access-Client-Id` / `CF-Access-Client-Secret`
 * to get past Access; the Worker still requires OpenSEO OAuth on MCP routes.
 *
 * When `mcpDiscoveryBypass` is set, also provisions a Bypass (everyone)
 * application for the OAuth discovery paths (`/.well-known/oauth-*`):
 * discovery metadata is public by design (RFC 8414) and both machine clients
 * and user agents must reach it — the hostname-wide email gate would
 * otherwise 302 them. The Worker serves metadata only on those paths.
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
  /** MCP path service-token gate (self-host only; leave unset for previews). */
  mcpServiceAuth?: {
    serviceTokenId: string;
    serviceTokenName: string;
    policyId: string;
    applicationId: string;
    policyName: string;
    applicationName: string;
  };
  /** OAuth discovery-path bypass (self-host only; metadata is public). */
  mcpDiscoveryBypass?: {
    policyId: string;
    applicationId: string;
    policyName: string;
    applicationName: string;
  };
}) =>
  Effect.gen(function* () {
    const hostnames = [
      options.domain,
      ...(options.extraDomains ?? []),
    ].filter(
      (hostname, index, all) => hostname && all.indexOf(hostname) === index,
    );

    let mcpPolicyAud: Alchemy.Input<string> | undefined;
    if (options.mcpServiceAuth) {
      const token = yield* Cloudflare.Access.ServiceToken(
        options.mcpServiceAuth.serviceTokenId,
        { name: options.mcpServiceAuth.serviceTokenName },
      );
      // The service-token policy attaches ONLY to the path-scoped /mcp app
      // below — never to the hostname-wide app: there it would let a service
      // token mint a JWT with the user app's audience and walk the user door.
      const mcpPolicy = yield* Cloudflare.Access.Policy(
        options.mcpServiceAuth.policyId,
        {
          name: options.mcpServiceAuth.policyName,
          decision: "non_identity",
          include: [{ serviceToken: { tokenId: token.serviceTokenId } }],
        },
      );
      // Path-scoped apps beat the hostname-wide gate for /mcp/* and issue
      // MCP_POLICY_AUD for service-token JWT verification in the Worker.
      const mcpPaths = hostnames.map((hostname) => `${hostname}/mcp`);
      const mcpApplication = yield* Cloudflare.Access.Application(
        options.mcpServiceAuth.applicationId,
        {
          type: "self_hosted",
          name: options.mcpServiceAuth.applicationName,
          domain: mcpPaths[0],
          destinations: mcpPaths.map((uri) => ({
            type: "public" as const,
            uri,
          })),
          policies: [mcpPolicy.policyId],
        },
      );
      mcpPolicyAud = mcpApplication.aud;
    }

    if (options.mcpDiscoveryBypass) {
      const discoveryBypass = yield* Cloudflare.Access.Policy(
        options.mcpDiscoveryBypass.policyId,
        {
          name: options.mcpDiscoveryBypass.policyName,
          decision: "bypass",
          include: [{ everyone: {} }],
        },
      );
      // OAuth discovery metadata is public (RFC 8414) and must be reachable
      // by machine clients AND user agents — the hostname-wide email gate
      // would otherwise 302 them. Path-scoped apps beat the hostname-wide
      // gate for /.well-known/oauth-*; the Worker serves metadata only there.
      const discoveryPaths = hostnames.flatMap((hostname) => [
        `${hostname}/.well-known/oauth-authorization-server`,
        `${hostname}/.well-known/oauth-protected-resource`,
      ]);
      yield* Cloudflare.Access.Application(
        options.mcpDiscoveryBypass.applicationId,
        {
          type: "self_hosted",
          name: options.mcpDiscoveryBypass.applicationName,
          domain: discoveryPaths[0],
          destinations: discoveryPaths.map((uri) => ({
            type: "public" as const,
            uri,
          })),
          policies: [discoveryBypass.policyId],
        },
      );
    }

    const allow = yield* Cloudflare.Access.Policy(options.policyId, {
      name: options.policyName,
      decision: "allow",
      include: options.emails.map((email) => ({ email: { email } })),
    });
    const application = yield* Cloudflare.Access.Application(
      options.applicationId,
      {
        type: "self_hosted",
        name: options.applicationName,
        domain: hostnames[0],
        // 1-month login sessions (Jon 2026-08-31) — set via API that day; kept
        // here so a redeploy doesn't silently reset the app to the 24h default.
        sessionDuration: "730h",
        // Skip the "Sign in with:" chooser page (Jon 2026-08-31: "it should
        // never ask") — with a single IdP, Access redirects straight through;
        // when the Cloudflare session is alive the whole flow is silent.
        autoRedirectToIdentity: true,
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

    return { application, mcpPolicyAud };
  });
