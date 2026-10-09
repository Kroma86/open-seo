import type { AuthorizationError } from "@cloudflare/workers-oauth-provider";

// Response builders for the MCP OAuth provider, split out of oauth-provider.ts
// to keep it under the max-lines lint limit. No auth decisions live here.

function getRelativeRequestTarget(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

export function redirectToSignIn(request: Request) {
  const signInUrl = new URL("/sign-in", request.url);
  signInUrl.searchParams.set("redirect", getRelativeRequestTarget(request));
  return Response.redirect(signInUrl.toString(), 302);
}

export function oauthErrorRedirect(input: {
  redirectUri: string;
  code: string;
  description: string;
  state?: string;
  issuer?: string;
}) {
  const redirectUrl = new URL(input.redirectUri);
  redirectUrl.searchParams.set("error", input.code);
  redirectUrl.searchParams.set("error_description", input.description);
  if (input.state) redirectUrl.searchParams.set("state", input.state);
  if (input.issuer) redirectUrl.searchParams.set("iss", input.issuer);
  return redirectUrl.toString();
}

export function authorizationErrorResponse(error: AuthorizationError) {
  if (!error.redirectUri) {
    return new Response(error.description, { status: 400 });
  }

  return Response.redirect(
    oauthErrorRedirect({
      redirectUri: error.redirectUri,
      code: error.code,
      description: error.description,
      state: error.state,
      issuer: error.issuer,
    }),
    302,
  );
}

export function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function logOAuthError(error: {
  code: string;
  description: string;
  status: number;
}) {
  // 401s here are the standard OAuth discovery handshake, not failures: an
  // unauthenticated /mcp hit returns `invalid_token` (which triggers the
  // client's .well-known discovery), and stale client registrations draw
  // `invalid_client` until the client re-registers. Log those at debug so
  // they stop masquerading as errors; keep 5xx at error and everything else
  // (bad client metadata, etc.) at warn.
  const line = `[oauth] ${error.status} ${error.code}: ${error.description}`;
  if (error.status === 401) {
    console.debug(line);
  } else if (error.status >= 500) {
    console.error(line);
  } else {
    console.warn(line);
  }

  // Returning void delegates the standards-compliant body, bearer challenge,
  // and CORS headers to workers-oauth-provider.
}

export function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}
