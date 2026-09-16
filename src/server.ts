import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import { routeAgentRequest } from "agents";
import { resolveCloudflareAccessMcpGate } from "@/middleware/ensure-user/cloudflareAccess";
import {
  resolveServiceTokenWorkspaceContext,
  resolveSharedWorkspaceContext,
} from "@/middleware/ensure-user/delegated";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { SamSessionRepository } from "@/server/features/sam/SamSessionRepository";
import { runScheduledRankChecks } from "@/server/features/rank-tracking/services/scheduledRankChecks";
import { reconcileStuckRankCheckRuns } from "@/server/features/rank-tracking/services/rankCheckReconciler";
import { runScheduledAiVisibilityChecks } from "@/server/features/ai-visibility/services/scheduledAiVisibilityChecks";
import { runScheduledSamLoops } from "@/server/features/sam-loops/services/scheduledSamLoops";
import { reconcileStaleAudits } from "@/server/features/audit/services/auditReconciler";
import { reconcileStaleAiVisibilityRuns } from "@/server/features/ai-visibility/services/aiVisibilityReconciler";
import { getOrCreateOrganizationCustomer } from "@/server/billing/subscription";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { getAuthMode, isHostedAuthMode } from "@/lib/auth-mode";
import {
  isSelfHostedMcpOAuthDiscoveryPath,
  isSelfHostedMcpOAuthProtocolPath,
  isUnderSelfhostOAuthDiscoveryPrefix,
} from "@/lib/oauth-resource";
import {
  createOpenSeoOAuthProvider,
  type OpenSeoOAuthEnv,
} from "@/server/mcp/oauth-provider";
import { requestWithPublicOrigin } from "@/server/mcp/public-origin";
import { MCP_ROUTE } from "@/server/mcp/context";
import { asAppError } from "@/server/lib/errors";
import { OAUTH_PROTECTED_RESOURCE_PATH } from "@/shared/mcp-discovery-paths";
import { handleSelfHostedOpenSeoMcpRequest } from "@/server/mcp/transport";
import { withPgClient } from "@/db";
import {
  AUTUMN_WEBHOOK_PATH,
  handleAutumnWebhookRequest,
} from "@/server/billing/autumn-webhook";
import { maybeSendSelfHostHeartbeat } from "@/server/lib/self-host-telemetry";
import { handleGdprStorageErasure } from "@/server/gdpr/storage-erasure";
import { GDPR_STORAGE_ERASURE_PATH } from "@/shared/gdpr-erasure";

const appFetch = createStartHandler(defaultStreamHandler);
const openSeoOAuthProvider = createOpenSeoOAuthProvider(appFetch);

// Compile-time guard for the `env as OpenSeoOAuthEnv` casts in this file:
// the self-host Env must carry OAUTH_KV. Fails tsc if the binding is removed.
type Assert<T extends true> = T;
type _EnvCarriesOAuthKv =
  Assert<Env extends Pick<OpenSeoOAuthEnv, "OAUTH_KV"> ? true : never>;

// Authorize an onboarding-chat connection in the Worker, before it reaches the
// Durable Object. The DO instance name is the projectId (set client-side); we
// resolve the session here and confirm the caller's org owns that project, so
// the DO can trust its `name`. Returning a Response rejects; void lets it through.
async function authorizeOnboardingChat(
  request: Request,
  projectId: string,
): Promise<Response | undefined> {
  let context;
  try {
    context = await resolveUserContextFromHeaders(request.headers);
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const project = await ProjectRepository.getProjectForOrganization(
    projectId,
    context.organizationId,
  );
  if (!project) {
    return new Response("Forbidden", { status: 403 });
  }
  // Ensure the org's Autumn customer exists (and gets its default onboarding-plan
  // credits) before the DO checks the balance — otherwise a brand-new org's first
  // message can hit a false "out of credits" gate. Hosted-only; self-hosted has
  // no Autumn.
  if (await isHostedServerAuthMode()) {
    await getOrCreateOrganizationCustomer(context);
  }
  return undefined;
}

// Authorize a SAM agent connection in the Worker, before it reaches the Durable
// Object. The DO instance name is the sessionId (set client-side); we resolve
// the session here and authorize the caller against the session's project via
// the same canonical project-access check the rest of the app uses, so the DO
// can trust its `name` and derive org/project/user from the session row.
async function authorizeSamChat(
  request: Request,
  sessionId: string,
): Promise<Response | undefined> {
  let context;
  try {
    context = await resolveUserContextFromHeaders(request.headers);
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const session = await SamSessionRepository.getActiveSession(
    sessionId,
    context.userId,
  );
  const project = session
    ? await ProjectRepository.getProjectForOrganization(
        session.projectId,
        context.organizationId,
      )
    : null;
  if (!session || !project) {
    return new Response("Forbidden", { status: 403 });
  }
  // Same as onboarding above: make sure the Autumn customer (and its default
  // free-plan credits) exists before the DO's balance gate runs, or a brand-new
  // org's first message hits a false "out of credits".
  if (await isHostedServerAuthMode()) {
    await getOrCreateOrganizationCustomer(context);
  }
  return undefined;
}

// Both chat DOs live behind /agents/*. Dispatch on the DO binding partyserver
// resolved for the request (rather than re-parsing the path), and fail closed
// on anything unrecognized.
function authorizeChatAgent(
  request: Request,
  lobby: { className: string; name: string },
): Promise<Response | undefined> | Response {
  switch (lobby.className) {
    case "SAM_CHAT":
      return authorizeSamChat(request, lobby.name);
    case "ONBOARDING_CHAT":
      return authorizeOnboardingChat(request, lobby.name);
    default:
      return new Response("Forbidden", { status: 403 });
  }
}

// Route /agents/* to the onboarding and SAM chat DOs. Auth happens here (both
// the WS upgrade and any HTTP message-history fetch), keeping it off the OAuth
// wrapper and TanStack route guard below.
async function routeChatAgents(request: Request, env: Env): Promise<Response> {
  const response = await routeAgentRequest(request, env, {
    onBeforeConnect: (req, lobby) => authorizeChatAgent(req, lobby),
    onBeforeRequest: (req, lobby) => authorizeChatAgent(req, lobby),
  });
  return response ?? new Response("Not found", { status: 404 });
}

function fetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // The MCP surface (OAuth discovery paths + /mcp) does Access JWT
  // verification — a remote JWKS round-trip — before any database work, and
  // its handlers scope their own DB clients where needed. Keep it OUT of the
  // request-wide pg scope: a pooled client must never be held across that
  // network wait (pool exhaustion under burst after cold start / key rotation).
  const pathname = new URL(request.url).pathname;
  const authMode = getAuthMode(env.AUTH_MODE);
  const isMcpSurface =
    authMode === "cloudflare_access"
      ? isSelfHostedMcpOAuthDiscoveryPath(pathname) ||
        isSelfHostedMcpOAuthProtocolPath(pathname) ||
        isUnderSelfhostOAuthDiscoveryPrefix(pathname) ||
        pathname === MCP_ROUTE
      : authMode === "local_noauth" && pathname === MCP_ROUTE;
  if (isMcpSurface) {
    return Promise.resolve(handleFetch(request, env, ctx));
  }
  // Scope a per-request Postgres client (no-op in D1 mode). The client isn't
  // closed here — the Workers↔Hyperdrive socket is reclaimed at invocation end.
  return withPgClient(() => Promise.resolve(handleFetch(request, env, ctx)));
}

/**
 * Turn a thrown gate error into the response the client should actually get.
 *
 * Exported so the failure branch is testable. Before this change nothing in
 * `src/server.test.ts` used mockRejectedValue, so the throw path had no
 * coverage at all — which is how it stayed broken.
 *
 * The 401's metadata URL comes from the request's own origin because this
 * Worker answers on two intentional hostnames and each client must be pointed
 * at the one it actually used. getPublicOrigin only consults x-forwarded-host
 * when the request URL is NOT https, which is the case in local dev and behind
 * a plain-http front, not on the Cloudflare edge. If that ever stops holding,
 * a forged x-forwarded-host would not admit anyone — the gate is unchanged —
 * but it could advertise a metadata URL on a host the operator did not choose.
 */
export function mcpGateErrorResponse(
  error: unknown,
  publicRequest: Request,
): Response {
  const appError = asAppError(error);

  if (appError?.code === "UNAUTHENTICATED") {
    // 401 with the resource metadata is what an MCP client needs in order to
    // discover the authorization server and start the OAuth flow. A 500 gives
    // it nothing to act on. This grants no access: the request is still
    // rejected, just in the language the protocol defines.
    const resourceMetadata = new URL(
      `${OAUTH_PROTECTED_RESOURCE_PATH}${MCP_ROUTE}`,
      new URL(publicRequest.url).origin,
    ).toString();
    return new Response(
      JSON.stringify({
        error: "unauthorized",
        error_description: "Cloudflare Access identity required for /mcp.",
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}"`,
        },
      },
    );
  }

  if (appError?.code === "AUTH_CONFIG_MISSING") {
    // A deployment fault, not a caller fault — but /mcp is reachable without
    // credentials, so the operator's guidance is NOT put in the body. errors.ts
    // marks AUTH_CONFIG_MISSING messages safe for the signed-in app UI, which
    // is a different audience from an anonymous endpoint, and nothing checks
    // what a future message might carry. The code names the fault to the
    // caller; the message is logged, which is the only place it now appears.
    console.error("[mcp] Access gate misconfigured:", appError.message);
    return new Response(JSON.stringify({ error: "server_misconfigured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return mcpFailureResponse(error);
}

/**
 * The answer for a fault that is NOT about the caller's identity — the OAuth
 * provider, the MCP transport, the workspace lookup, a database outage.
 *
 * It is deliberately not the 401: answering a transport fault with an Access
 * challenge would send a client off to re-authenticate over something
 * authentication cannot fix. It exists at all because anything thrown here and
 * left uncaught reaches the Workers runtime as an unhandled rejection, which
 * Cloudflare renders as error 1101 — the 500 this whole change is about.
 */
export function mcpFailureResponse(error: unknown): Response {
  console.error("[mcp] request failed:", error);
  return new Response(JSON.stringify({ error: "internal_error" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  ctx.waitUntil(maybeSendSelfHostHeartbeat());

  const authMode = getAuthMode(env.AUTH_MODE);
  const publicRequest = requestWithPublicOrigin(request);
  const pathname = new URL(publicRequest.url).pathname;

  if (pathname === GDPR_STORAGE_ERASURE_PATH) {
    return handleGdprStorageErasure(publicRequest, env);
  }

  if (pathname.startsWith("/agents/")) {
    return routeChatAgents(publicRequest, env);
  }

  if (isHostedAuthMode(authMode)) {
    if (pathname === AUTUMN_WEBHOOK_PATH) {
      return handleAutumnWebhookRequest(publicRequest);
    }

    return openSeoOAuthProvider.fetch(
      publicRequest,
      env as OpenSeoOAuthEnv,
      ctx,
    );
  }

  if (
    authMode === "cloudflare_access" &&
    (isSelfHostedMcpOAuthDiscoveryPath(pathname) ||
      isSelfHostedMcpOAuthProtocolPath(pathname))
  ) {
    let oauthRequest = publicRequest;
    if (pathname === "/.well-known/oauth-authorization-server/mcp") {
      const rewritten = new URL(publicRequest.url);
      rewritten.pathname = "/.well-known/oauth-authorization-server";
      oauthRequest = new Request(rewritten, publicRequest);
    }
    return openSeoOAuthProvider.fetch(
      oauthRequest,
      env as OpenSeoOAuthEnv,
      ctx,
    );
  }

  // The edge bypass for the discovery paths is PREFIX-matched; the Worker
  // allowlist above is exact. Anything else under those prefixes is a 404,
  // never the app — the edge must never admit more than the Worker serves.
  if (
    authMode === "cloudflare_access" &&
    isUnderSelfhostOAuthDiscoveryPrefix(pathname)
  ) {
    return new Response(null, { status: 404 });
  }

  if (
    (authMode === "cloudflare_access" || authMode === "local_noauth") &&
    pathname === MCP_ROUTE
  ) {
    if (authMode === "cloudflare_access" && publicRequest.method !== "OPTIONS") {
      // The gate raises AppError for its rejections — no Access JWT, an
      // audience mismatch, TEAM_DOMAIN unset. Nothing in the chain caught them,
      // so they reached the Workers runtime as an unhandled rejection and
      // Cloudflare turned each one into error 1101, "Worker threw exception",
      // which clients see as a 500. An MCP client arriving without a token got
      // a server error instead of the 401 that tells it to authenticate, so it
      // could never start the OAuth flow at all.
      // Two catches with different answers. The gate gets the 401, because its
      // failure really is about the caller's identity. Everything behind it
      // gets a plain 500, because answering a transport or database fault with
      // an Access challenge would send a client off to re-authenticate over
      // something authentication cannot fix. Neither may throw: an uncaught
      // rejection here is exactly the 1101 this change exists to remove. That covers the
      // gate, the provider, the transport and the workspace lookup under
      // cloudflare_access — not every exit from /mcp. The OPTIONS preflight
      // below still calls the handler outside any try.
      // The gate is Access JWT verification only (remote JWKS, NO database) —
      // safe outside any pooled-client scope (see the MCP-surface bypass in
      // fetch). The workspace context (DB) gets its own short client scope,
      // taken AFTER the network wait, never held across it.
      let gate: Awaited<ReturnType<typeof resolveCloudflareAccessMcpGate>>;
      try {
        gate = await resolveCloudflareAccessMcpGate(publicRequest.headers);
      } catch (error) {
        // Only the GATE earns the 401. It is the one call whose failure really
        // does mean "your identity did not check out".
        return mcpGateErrorResponse(error, publicRequest);
      }

      // Everything past this point has already proved identity, so a failure is
      // ours, not the caller's. `return await` matters: without the await the
      // promise escapes the try and rejects into the runtime as a 1101.
      try {
        // A verified service token IS an identity. Cloudflare Access has
        // already proved which machine is calling, so handing it to the OAuth
        // provider asked a headless caller to finish a browser login it can
        // never finish: it 401d, and the only way back was a person pasting a
        // fresh token every fifteen minutes. Machines get their own workspace
        // context instead, in the same shared workspace people use.
        const accessContext = await withPgClient(() =>
          gate.kind === "service_token"
            ? resolveServiceTokenWorkspaceContext(gate.commonName)
            : resolveSharedWorkspaceContext(gate.userId, gate.userEmail),
        );
        return await handleSelfHostedOpenSeoMcpRequest(
          publicRequest,
          authMode,
          env,
          ctx,
          accessContext,
        );
      } catch (error) {
        return mcpFailureResponse(error);
      }
    }

    return handleSelfHostedOpenSeoMcpRequest(
      publicRequest,
      authMode,
      env,
      ctx,
      null,
    );
  }

  return appFetch(request);
}

// Export Workflow classes as named exports
export { SiteAuditWorkflow } from "./server/workflows/SiteAuditWorkflow";
export { RankCheckWorkflow } from "./server/workflows/RankCheckWorkflow";
export { SamLoopWorkflow } from "./server/workflows/SamLoopWorkflow";
// Durable Object class for the onboarding strategy chat (Agents SDK).
export { OnboardingChatAgent } from "./server/features/onboarding/OnboardingChatAgent";
// Durable Object class for the SAM in-app agent (Agents SDK).
export { SamChatAgent } from "./server/features/sam/SamChatAgent";
// Durable Object class for the per-audit crawl scratchpad.
export { AuditScratchpad } from "./server/features/audit/AuditScratchpad";

// Daily OAuth KV garbage collection; must match a trigger in wrangler.jsonc.
const MCP_OAUTH_PURGE_CRON = "17 3 * * *";

export default {
  fetch,
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    if (controller.cron === MCP_OAUTH_PURGE_CRON) {
      // Only hosted mode runs the OAuth provider (and has OAUTH_KV bound).
      if (isHostedAuthMode(getAuthMode(env.AUTH_MODE))) {
        const result = await openSeoOAuthProvider.purgeExpiredData(
          env as OpenSeoOAuthEnv,
        );
        console.log("[mcp-oauth] purged expired OAuth data", result);
        if (!result.done) {
          // The sweep only advances past live records via deletions; a
          // persistent incomplete scan means the keyspace outgrew the batch.
          console.warn("[mcp-oauth] purge did not cover the full keyspace");
        }
      }
      return;
    }

    // Watchdog first: reconcile audits stuck in "running" whose workflow died
    // without reaching mark-failed (OOM/CPU kills, expired instances). Runs
    // before the rank loop so a slow tick can't delay or starve it. Its
    // failure is held until after the rank checks so it can't suppress them,
    // then rethrown so the invocation still reports as failed.
    let watchdogError: unknown;
    try {
      await withPgClient(() => reconcileStaleAudits());
      await withPgClient(() => reconcileStaleAiVisibilityRuns());
      await withPgClient(() => reconcileStuckRankCheckRuns());
    } catch (err) {
      watchdogError = err;
      console.error("[cron] Stale-audit reconcile failed:", err);
    }
    // Scope a per-request Postgres client for the cron run (no-op in D1 mode).
    await withPgClient(() => runScheduledRankChecks(env));
    await withPgClient(() => runScheduledAiVisibilityChecks(env));
    await withPgClient(() => runScheduledSamLoops(env));
    if (watchdogError) throw watchdogError;
  },
};
