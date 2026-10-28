import { normalizeDomain } from "@/types/schemas/domain";

// NIC-766: these headings and titles stay client-owned, including manual cards.
const CLIENT_OWNED_HEADINGS = new Set([
  "cinnamoncounselling.com",
  "cinnamoncounselling.ca",
]);

export function assertClientFieldsAllowed(
  domain: string,
  fixes: Record<string, unknown>,
): void {
  const host = normalizeDomain(domain).replace(/\.+$/, "");
  if (
    CLIENT_OWNED_HEADINGS.has(host) &&
    Object.keys(fixes).some((field) => field === "h1" || field === "title")
  ) {
    throw new Error("client_owned_heading_title");
  }
}
