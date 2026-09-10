import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

// Records every Access Policy/Application the gate provisions, so the test
// can assert the TOPOLOGY, not just behavior: which policy lands on which
// application. The C1 invariant (the service-token policy never attaches to
// the hostname-wide user gate) is a property of this wiring — a code comment
// alone cannot hold it.
const calls = vi.hoisted(() => ({
  applications: [] as {
    id: string;
    policies: string[];
    destinations: string[];
  }[],
}));

vi.mock("alchemy/Cloudflare", async () => {
  const Eff = await import("effect/Effect");
  return {
    Access: {
      ServiceToken: (id: string, _props: unknown) =>
        Eff.succeed({ serviceTokenId: `st:${id}` }),
      Policy: (id: string, _props: unknown) =>
        Eff.succeed({ policyId: `pol:${id}` }),
      Application: (
        id: string,
        props: { policies?: string[]; destinations?: { uri: string }[] },
      ) => {
        calls.applications.push({
          id,
          policies: props.policies ?? [],
          destinations: (props.destinations ?? []).map((d) => d.uri),
        });
        return Eff.succeed({ aud: `aud:${id}` });
      },
    },
  };
});

import { SELFHOST_OAUTH_DISCOVERY_PATH_PREFIXES } from "./src/shared/mcp-discovery-paths.ts";
import { emailAccessGate } from "./alchemy.access";

const OPTIONS = {
  policyId: "SelfHostAllowUsers",
  applicationId: "SelfHostAccess",
  policyName: "users",
  applicationName: "app",
  domain: "seo.example.com",
  emails: ["jon@example.com"],
  internalApiBypass: {
    policyId: "SelfHostInternalBypass",
    applicationId: "SelfHostInternalAccess",
    policyName: "bypass",
    applicationName: "bypass",
  },
  mcpServiceAuth: {
    serviceTokenId: "GrokBotMcpServiceToken",
    serviceTokenName: "grok-bot",
    policyId: "SelfHostMcpServiceAuth",
    applicationId: "SelfHostMcpAccess",
    policyName: "mcp svc",
    applicationName: "mcp",
  },
  mcpDiscoveryBypass: {
    policyId: "SelfHostMcpDiscoveryBypass",
    applicationId: "SelfHostMcpDiscoveryAccess",
    policyName: "disc",
    applicationName: "disc",
  },
};

describe("emailAccessGate topology", () => {
  it("attaches the service-token policy ONLY to the /mcp app — never the hostname-wide user gate (C1 invariant)", async () => {
    calls.applications.length = 0;
    const result = await Effect.runPromise(
      emailAccessGate(OPTIONS) as Effect.Effect<
        { application: unknown; mcpPolicyAud: string },
        never,
        never
      >,
    );

    const byId = new Map(calls.applications.map((a) => [a.id, a.policies]));

    // The user gate: email policy only. A service-token policy here would
    // mint user-audience JWTs for machines — the C1 hole.
    expect(byId.get("SelfHostAccess")).toEqual(["pol:SelfHostAllowUsers"]);
    // The service-token policy attaches to the /mcp app and nowhere else.
    expect(byId.get("SelfHostMcpAccess")).toEqual(["pol:SelfHostMcpServiceAuth"]);
    const appsWithServicePolicy = [...byId.entries()]
      .filter(([, policies]) => policies.includes("pol:SelfHostMcpServiceAuth"))
      .map(([id]) => id);
    expect(appsWithServicePolicy).toEqual(["SelfHostMcpAccess"]);
    // Discovery is bypass-everyone on its own scoped app.
    expect(byId.get("SelfHostMcpDiscoveryAccess")).toEqual([
      "pol:SelfHostMcpDiscoveryBypass",
    ]);
    // ...and its destinations are EXACTLY the shared discovery prefixes on
    // each hostname — a bare-hostname typo here would bypass-everyone the
    // entire site, and this assertion is the only thing that catches it.
    const destinationsById = new Map(
      calls.applications.map((a) => [a.id, a.destinations]),
    );
    expect(destinationsById.get("SelfHostMcpDiscoveryAccess")).toEqual(
      [...SELFHOST_OAUTH_DISCOVERY_PATH_PREFIXES].map(
        (p) => `seo.example.com${p}`,
      ),
    );
    expect(destinationsById.get("SelfHostMcpAccess")).toEqual([
      "seo.example.com/mcp",
    ]);
    // The worker binds the /mcp app's AUD as MCP_POLICY_AUD.
    expect(result.mcpPolicyAud).toBe("aud:SelfHostMcpAccess");
  });
});
