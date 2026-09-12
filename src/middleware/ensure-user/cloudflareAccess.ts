import { env } from "cloudflare:workers";
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { AppError } from "@/server/lib/errors";
import { validateTeamDomain } from "@/shared/selfhost-checks";
import { classifyAccessVerificationError } from "./accessTokenErrors";
import { resolveSharedWorkspaceContext } from "./delegated";
import type { EnsuredUserContext } from "./types";

const jwksByTeamDomain = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

function getJwks(teamDomain: string) {
  const existing = jwksByTeamDomain.get(teamDomain);
  if (existing) {
    return existing;
  }

  const jwks = createRemoteJWKSet(
    new URL(`${teamDomain}/cdn-cgi/access/certs`),
  );

  jwksByTeamDomain.set(teamDomain, jwks);

  return jwks;
}

function getValidatedTeamDomain(teamDomain: string) {
  const result = validateTeamDomain(teamDomain);

  if (!result.ok) {
    throw new AppError("AUTH_CONFIG_MISSING", result.message);
  }

  return result.origin;
}

function getAccessConfig() {
  const teamDomain = env.TEAM_DOMAIN
    ? getValidatedTeamDomain(env.TEAM_DOMAIN)
    : null;
  const policyAud = env.POLICY_AUD?.trim() || null;
  const mcpPolicyAud = env.MCP_POLICY_AUD?.trim() || null;

  return { teamDomain, policyAud, mcpPolicyAud };
}

function missingAccessConfigMessage(
  teamDomain: string | null,
  policyAud: string | null,
) {
  const missing = [
    teamDomain ? null : "TEAM_DOMAIN",
    policyAud ? null : "POLICY_AUD",
  ]
    .filter(Boolean)
    .join(" and ");
  return `Missing Cloudflare Access configuration: set ${missing} on the deployment. See docs/SELF_HOSTING_CLOUDFLARE.md.`;
}

async function verifyAccessTokenForAudience(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<JWTPayload | null> {
  try {
    const jwks = getJwks(teamDomain);
    const { payload } = await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience,
    });
    return payload;
  } catch (error) {
    if (
      error instanceof joseErrors.JWTClaimValidationFailed &&
      error.claim === "aud"
    ) {
      return null;
    }

    console.error("Cloudflare Access token verification failed:", error);
    throw classifyAccessVerificationError(error);
  }
}

export type CloudflareAccessMcpGate =
  | { kind: "service_token" }
  // Verified identity ONLY — the workspace context (DB work) is resolved by
  // the caller inside its own client scope. Keeping DB out of this function
  // keeps the remote JWKS verification out of any pooled-client scope.
  | { kind: "user"; userId: string; userEmail: string };

export async function resolveCloudflareAccessMcpGate(
  headers: Headers,
): Promise<CloudflareAccessMcpGate> {
  const { teamDomain, policyAud, mcpPolicyAud } = getAccessConfig();

  if (!teamDomain || !policyAud) {
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      missingAccessConfigMessage(teamDomain, policyAud),
    );
  }

  const token = headers.get("cf-access-jwt-assertion");

  if (!token) {
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      "No Cloudflare Access token on the request. Cloudflare Access is not enabled in front of this deployment — add an Access application covering this hostname in Zero Trust, or set AUTH_MODE=local_noauth if you intend to run without auth on a private network.",
    );
  }

  if (mcpPolicyAud) {
    const servicePayload = await verifyAccessTokenForAudience(
      token,
      teamDomain,
      mcpPolicyAud,
    );
    if (servicePayload) {
      // Audience alone does not prove kind — assert the claim shape too:
      // service-token JWTs carry common_name; user JWTs never do.
      if (typeof servicePayload.common_name !== "string") {
        throw new AppError("UNAUTHENTICATED");
      }
      return { kind: "service_token" };
    }
  }

  const userPayload = await verifyAccessTokenForAudience(
    token,
    teamDomain,
    policyAud,
  );
  if (!userPayload) {
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      mcpPolicyAud
        ? "Cloudflare Access token rejected: audience mismatch. POLICY_AUD and MCP_POLICY_AUD do not match the Access applications that issued this token — copy each application's AUD tag from Zero Trust -> Access controls -> Applications -> Configure -> Additional settings."
        : "Cloudflare Access token rejected: audience mismatch. POLICY_AUD does not match your Access application's AUD tag — copy it from Zero Trust -> Access controls -> Applications -> Configure -> Additional settings.",
    );
  }

  // A service token presented at the user door (e.g. a hostname-wide Access
  // app misconfigured to also accept service tokens) is NOT a user, whatever
  // its audience says: service-token JWTs carry common_name.
  if (typeof userPayload.common_name === "string") {
    throw new AppError("UNAUTHENTICATED");
  }

  const userId = typeof userPayload.sub === "string" ? userPayload.sub : null;
  const userEmail =
    typeof userPayload.email === "string" ? userPayload.email : null;

  if (!userId || !userEmail) {
    throw new AppError("UNAUTHENTICATED");
  }

  return { kind: "user", userId, userEmail };
}

export async function resolveCloudflareAccessContext(
  headers: Headers,
): Promise<EnsuredUserContext> {
  const gate = await resolveCloudflareAccessMcpGate(headers);
  if (gate.kind === "service_token") {
    throw new AppError("UNAUTHENTICATED");
  }

  return resolveSharedWorkspaceContext(gate.userId, gate.userEmail);
}
