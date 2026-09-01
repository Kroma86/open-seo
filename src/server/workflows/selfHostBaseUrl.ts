const HOSTED_APP_ORIGIN = "https://app.openseo.so";

/** Dashboard origin for tool links. Self-host sets BETTER_AUTH_URL to seo.niceseo.ai. */
export function selfHostBaseUrl(env: { BETTER_AUTH_URL?: string }): string {
  const raw = env.BETTER_AUTH_URL?.trim();
  if (!raw) return HOSTED_APP_ORIGIN;
  try {
    return new URL(raw).origin;
  } catch {
    return HOSTED_APP_ORIGIN;
  }
}
