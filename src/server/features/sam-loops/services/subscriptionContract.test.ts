import { describe, expect, it } from "vitest";
import {
  subscriptionTurnSchema,
  validateSubscriptionFinal,
} from "./subscriptionContract";

describe("subscription structured results", () => {
  it("accepts complete plain-English reports", async () => {
    const result = await validateSubscriptionFinal(
      {
        kind: "final",
        status: "completed",
        report: "Rankings were not measured.",
        error: null,
        article: null,
      },
      false,
      [],
      "example.com",
    );
    expect(result).toMatchObject({
      status: "completed",
      error: null,
      costNote: "subscription; model API cost $0",
    });
  });
  it("rejects unknown fields and malformed turns", () => {
    expect(
      subscriptionTurnSchema.safeParse({
        kind: "tool",
        tool: "read_pages",
        arguments: {},
        status: "completed",
      }).success,
    ).toBe(false);
  });
  it("turns empty results into a reasoned failure", async () => {
    const result = await validateSubscriptionFinal(
      {
        kind: "final",
        status: "completed",
        report: "",
        error: null,
        article: null,
      },
      false,
      [],
      "example.com",
    );
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(
      /Generation did not return a complete valid result:.*report/i,
    );
  });
  it("rejects fabricated monthly evidence", async () => {
    const result = await validateSubscriptionFinal(
      {
        kind: "final",
        status: "completed",
        report: "Draft complete",
        error: null,
        article: {
          outcome: "draft",
          reason: "",
          title: "Example title",
          targetKeyword: "fiction",
          body: "A draft",
          sources: [],
        },
      },
      true,
      [],
      "example.com",
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("selected topic");
  });
  it("requires a reason on failed reports", async () => {
    const result = await validateSubscriptionFinal(
      {
        kind: "final",
        status: "failed",
        report: "No evidence.",
        error: null,
        article: null,
      },
      false,
      [],
      "example.com",
    );
    expect(result.error).toContain("failure reason");
  });
  it("never stores unverified monthly evidence in a failed report", async () => {
    const result = await validateSubscriptionFinal(
      {
        kind: "final",
        status: "failed",
        report: "Fabricated article and verification marker",
        error: "Missing sources",
        article: null,
      },
      true,
      [],
      "example.com",
    );
    expect(result.report).toBe(
      "No verified monthly article draft — subscription generation reported failure.",
    );
  });
});
