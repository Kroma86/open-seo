import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Ga4Service } from "@/server/features/ga4/services/Ga4Service";
import { AppError } from "@/server/lib/errors";
import {
  assertAgencyToken,
  findOwnedProject,
  NO_STORE,
  normalizeProjectDomain,
  resolveGrantHolders,
  resolveOrganizationId,
  unsupportedAuthMode,
} from "./-googleGrantRouteSupport";

const postBodySchema = z.object({
  projectId: z.string().trim().min(1),
  propertyId: z
    .string()
    .trim()
    .regex(/^properties\/\d+$/)
    .optional(),
  acceptDisplayNameMismatch: z.boolean().optional(),
});

type VisibleProperty = {
  accountId: string;
  propertyId: string;
  displayName: string;
};

type Ga4Candidate = {
  propertyId: string;
  displayName: string;
};

function ga4DisplayNameMatches(displayName: string, domain: string): boolean {
  const display = displayName.trim().toLowerCase();
  const normalizedDomain = domain.trim().toLowerCase();
  if (display === normalizedDomain) return true;
  if (display.startsWith("www.") && display.slice(4) === normalizedDomain) {
    return true;
  }
  if (display === `${normalizedDomain} - ga4`) return true;
  if (display === `${normalizedDomain} (ga4)`) return true;
  for (const scheme of ["https://", "http://"] as const) {
    const prefix = `${scheme}${normalizedDomain}`;
    if (display === prefix) return true;
    if (display.startsWith(prefix) && display.length > prefix.length) {
      const next = display[prefix.length];
      if (next === "/" || next === "?" || next === "#" || next === " ") {
        return true;
      }
    }
  }
  return false;
}

function flattenVisibleProperties(
  listed: Awaited<
    ReturnType<typeof Ga4Service.listPropertiesForUserWithGrantStatus>
  >,
): VisibleProperty[] {
  const visible: VisibleProperty[] = [];
  for (const listedAccount of listed.accounts) {
    if (
      listedAccount.requiresReconnect ||
      listedAccount.propertiesUnavailable
    ) {
      continue;
    }
    for (const property of listedAccount.properties) {
      visible.push({
        accountId: listedAccount.accountId,
        propertyId: property.propertyId,
        displayName: property.displayName,
      });
    }
  }
  return visible;
}

function orderVisibleByAccountIds(
  visible: VisibleProperty[],
  accountIds: string[],
): VisibleProperty[] {
  const rank = new Map(accountIds.map((id, index) => [id, index]));
  return visible.toSorted((left, right) => {
    const leftRank = rank.get(left.accountId) ?? Number.POSITIVE_INFINITY;
    const rightRank = rank.get(right.accountId) ?? Number.POSITIVE_INFINITY;
    return leftRank - rightRank;
  });
}

function toCandidates(properties: VisibleProperty[]): Ga4Candidate[] {
  return properties.slice(0, 20).map((property) => ({
    propertyId: property.propertyId,
    displayName: property.displayName,
  }));
}

function propertyNotVisible(
  reason: "no_grant" | "no_match" | "not_visible" | "service_rejected",
  candidates: Ga4Candidate[],
): Response {
  return Response.json(
    { error: "property_not_visible", reason, candidates },
    { status: 404, headers: NO_STORE },
  );
}

function mapSetPropertyError(
  error: unknown,
  candidates: Ga4Candidate[],
): Response {
  if (error instanceof AppError && error.code === "NOT_FOUND") {
    return propertyNotVisible("service_rejected", candidates);
  }
  if (error instanceof AppError && error.code === "FORBIDDEN") {
    return Response.json(
      { error: "property_unverified" },
      { status: 403, headers: NO_STORE },
    );
  }
  return Response.json(
    { error: "attach_failed" },
    { status: 500, headers: NO_STORE },
  );
}

export async function handleGet(request: Request): Promise<Response> {
  const denied = assertAgencyToken(request);
  if (denied) return denied;

  const organizationId = resolveOrganizationId();
  if (organizationId === null) return unsupportedAuthMode();

  const projectId =
    new URL(request.url).searchParams.get("projectId")?.trim() ?? "";
  if (!projectId) {
    return Response.json(
      { error: "invalid_query" },
      { status: 400, headers: NO_STORE },
    );
  }

  const project = await findOwnedProject(organizationId, projectId);
  if (!project) {
    return Response.json(
      { error: "project_not_found" },
      { status: 404, headers: NO_STORE },
    );
  }

  const connection = await Ga4Service.getConnection(projectId);
  if (!connection) {
    return Response.json(
      {
        projectId,
        connected: false,
        propertyId: null,
        displayName: null,
        connectedAt: null,
      },
      { headers: NO_STORE },
    );
  }

  return Response.json(
    {
      projectId,
      connected: true,
      propertyId: connection.propertyId,
      displayName: connection.propertyDisplayName,
      connectedAt: connection.createdAt ?? null,
    },
    { headers: NO_STORE },
  );
}

export async function handlePost(request: Request): Promise<Response> {
  const denied = assertAgencyToken(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json" },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!body || typeof body !== "object") {
    return Response.json(
      { error: "invalid_body" },
      { status: 400, headers: NO_STORE },
    );
  }

  const parsed = postBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_body" },
      { status: 400, headers: NO_STORE },
    );
  }

  const organizationId = resolveOrganizationId();
  if (organizationId === null) return unsupportedAuthMode();

  const {
    projectId,
    propertyId: requestedPropertyId,
    acceptDisplayNameMismatch,
  } = parsed.data;
  const project = await findOwnedProject(organizationId, projectId);
  if (!project) {
    return Response.json(
      { error: "project_not_found" },
      { status: 404, headers: NO_STORE },
    );
  }

  const projectDomain = project.domain?.trim() ?? "";
  if (!projectDomain) {
    return Response.json(
      { error: "project_has_no_domain" },
      { status: 400, headers: NO_STORE },
    );
  }

  const existing = await Ga4Service.getConnection(projectId);
  if (existing) {
    if (
      requestedPropertyId == null ||
      requestedPropertyId === existing.propertyId
    ) {
      return Response.json(
        {
          projectId,
          propertyId: existing.propertyId,
          displayName: existing.propertyDisplayName,
          connectedAt: existing.createdAt ?? null,
        },
        { headers: NO_STORE },
      );
    }
    return Response.json(
      {
        error: "already_connected",
        propertyId: existing.propertyId,
        displayName: existing.propertyDisplayName,
      },
      { status: 409, headers: NO_STORE },
    );
  }

  const holders = await resolveGrantHolders(organizationId, "google-analytics");
  if (holders.length === 0) {
    return propertyNotVisible("no_grant", []);
  }

  const domain = normalizeProjectDomain(projectDomain);
  const candidateUnion: Ga4Candidate[] = [];
  let chosen: VisibleProperty | null = null;
  let chosenUserId: string | null = null;
  let chosenCandidates: Ga4Candidate[] = [];
  let displayNameMismatchAccepted = false;

  for (const holder of holders) {
    const listed = await Ga4Service.listPropertiesForUserWithGrantStatus(
      holder.userId,
    );
    const visible = orderVisibleByAccountIds(
      flattenVisibleProperties(listed),
      holder.accountIds,
    );
    const holderCandidates = toCandidates(visible);
    for (const candidate of holderCandidates) {
      if (candidateUnion.length >= 20) break;
      if (
        candidateUnion.some((row) => row.propertyId === candidate.propertyId)
      ) {
        continue;
      }
      candidateUnion.push(candidate);
    }

    if (requestedPropertyId != null) {
      const match =
        visible.find(
          (property) => property.propertyId === requestedPropertyId,
        ) ?? null;
      if (!match) continue;
      if (!ga4DisplayNameMatches(match.displayName, domain)) {
        if (!acceptDisplayNameMismatch) {
          return Response.json(
            {
              error: "display_name_mismatch",
              propertyId: match.propertyId,
              displayName: match.displayName,
              domain,
            },
            { status: 409, headers: NO_STORE },
          );
        }
        console.warn(
          `GA4 display_name_mismatch accepted for projectId=${projectId} propertyId=${match.propertyId} displayName=${match.displayName}`,
        );
        displayNameMismatchAccepted = true;
      }
      chosen = match;
      chosenUserId = holder.userId;
      chosenCandidates = holderCandidates;
      break;
    }

    const matches: VisibleProperty[] = [];
    const seenPropertyIds = new Set<string>();
    for (const property of visible) {
      if (!ga4DisplayNameMatches(property.displayName, domain)) continue;
      if (seenPropertyIds.has(property.propertyId)) continue;
      seenPropertyIds.add(property.propertyId);
      matches.push(property);
    }
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      return Response.json(
        {
          error: "ambiguous",
          candidates: matches.map((property) => ({
            propertyId: property.propertyId,
            displayName: property.displayName,
          })),
        },
        { status: 409, headers: NO_STORE },
      );
    }
    const pick = matches[0] ?? null;
    if (!pick) continue;
    chosen = pick;
    chosenUserId = holder.userId;
    chosenCandidates = holderCandidates;
    break;
  }

  if (!chosen || chosenUserId == null) {
    return propertyNotVisible(
      requestedPropertyId != null ? "not_visible" : "no_match",
      candidateUnion,
    );
  }

  try {
    const connection = await Ga4Service.setProperty({
      projectId,
      organizationId,
      propertyId: chosen.propertyId,
      accountId: chosen.accountId,
      userId: chosenUserId,
    });
    return Response.json(
      {
        projectId,
        propertyId: connection.propertyId,
        displayName: connection.propertyDisplayName,
        connectedAt: connection.createdAt ?? null,
        ...(displayNameMismatchAccepted
          ? { displayNameMismatchAccepted: true }
          : {}),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return mapSetPropertyError(error, chosenCandidates);
  }
}

export const Route = createFileRoute("/api/internal/ga4")({
  server: {
    handlers: {
      GET: ({ request }) => handleGet(request),
      POST: ({ request }) => handlePost(request),
    },
  },
});
