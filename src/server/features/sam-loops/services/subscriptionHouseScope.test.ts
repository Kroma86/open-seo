import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import {
  getMocks,
  projectId,
  loopId,
  scheduledFor,
} from "./subscriptionSamLoops.fixture";
import {
  getSubscriptionLoopRequest,
  postSubscriptionLoopRequest,
} from "./subscriptionSamLoops";
import { subscriptionRequestSchema } from "./subscriptionContract";

const mocks = getMocks();
const scope = { projectId, loopId, domain: "niceseo.ai" };
const houseClaim = {
  action: "claim" as const,
  projectId,
  loopId,
  scheduledFor,
  model: "grok-4.7" as const,
  houseOnly: true as const,
};

function houseTools() {
  mocks.prepare.mockResolvedValue({
    system: "Synthetic house test",
    prompt: "Stored evidence only",
    monthly: false,
    domain: "niceseo.ai",
    tools: Object.fromEntries(
      [
        "get_audit_issues",
        "propose_homegrown_otto_fixes",
        "get_business_profile",
      ].map((name) => [
        name,
        tool({ inputSchema: z.object({}).strict(), execute: mocks.execute }),
      ]),
    ),
  });
}

async function claimHouse() {
  const result = await postSubscriptionLoopRequest(houseClaim);
  if (!("receipt" in result) || !("tools" in result))
    throw new Error("Synthetic house claim missing receipt or tools");
  return result;
}

describe("explicit house subscription boundary", () => {
  it("attests exact house scope and advertises only stored readers", async () => {
    houseTools();
    const preview = await getSubscriptionLoopRequest(
      new URL(
        `https://seo.niceseo.ai/api/internal/sam-loop-subscription?projectId=${projectId}&loopId=${loopId}&houseOnly=true`,
      ),
    );
    expect(preview).toMatchObject({ houseOnly: true, domain: "niceseo.ai" });
    const claimed = await claimHouse();
    expect(claimed).toMatchObject({ houseOnly: true });
    expect(claimed.tools.map((entry) => entry.name)).toEqual([
      "get_audit_issues",
    ]);
    expect(mocks.admit).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, loopId, domain: "niceseo.ai" }),
      expect.anything(),
    );
  });

  it("rejects client scope even when ordinary loops are enabled", async () => {
    mocks.project.mockResolvedValue({
      id: projectId,
      domain: "client.example.test",
      loopsEnabled: true,
    });
    await expect(postSubscriptionLoopRequest(houseClaim)).rejects.toThrow(
      "loop_not_house",
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("rejects a prepared prompt whose domain differs", async () => {
    houseTools();
    mocks.prepare.mockResolvedValue({
      system: "Synthetic",
      prompt: "Synthetic",
      monthly: false,
      domain: "client.example.test",
      tools: {},
    });
    await expect(postSubscriptionLoopRequest(houseClaim)).rejects.toThrow(
      "loop_not_house",
    );
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("rejects malformed scope flags", () => {
    for (const flag of [false, "true", 1, null]) {
      expect(
        subscriptionRequestSchema.safeParse({ ...houseClaim, houseOnly: flag })
          .success,
      ).toBe(false);
    }
  });

  it("rejects dropping a signed house boundary before a tool", async () => {
    houseTools();
    const claimed = await claimHouse();
    await expect(
      postSubscriptionLoopRequest({
        action: "tool",
        projectId,
        loopId,
        runId: claimed.runId,
        receipt: claimed.receipt,
        step: 1,
        tool: "get_audit_issues",
        arguments: {},
      }),
    ).rejects.toThrow("house_scope_changed");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("does not execute after atomic scope reservation fails", async () => {
    houseTools();
    const claimed = await claimHouse();
    mocks.cas.mockResolvedValue(false);
    await expect(
      postSubscriptionLoopRequest({
        action: "tool",
        houseOnly: true,
        projectId,
        loopId,
        runId: claimed.runId,
        receipt: claimed.receipt,
        step: 1,
        tool: "get_audit_issues",
        arguments: {},
      }),
    ).rejects.toThrow("state_changed");
    expect(mocks.cas).toHaveBeenCalledWith(
      claimed.runId,
      expect.any(String),
      expect.anything(),
      undefined,
      scope,
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("guards both tool reservation and result settlement", async () => {
    houseTools();
    const claimed = await claimHouse();
    await postSubscriptionLoopRequest({
      action: "tool",
      houseOnly: true,
      projectId,
      loopId,
      runId: claimed.runId,
      receipt: claimed.receipt,
      step: 1,
      tool: "get_audit_issues",
      arguments: {},
    });
    expect(mocks.cas.mock.calls).toHaveLength(2);
    for (const call of mocks.cas.mock.calls) expect(call[4]).toEqual(scope);
  });

  it("rechecks domain before completion", async () => {
    houseTools();
    const claimed = await claimHouse();
    mocks.project.mockResolvedValue({
      id: projectId,
      domain: "client.example.test",
      loopsEnabled: true,
    });
    await expect(
      postSubscriptionLoopRequest({
        action: "complete",
        houseOnly: true,
        projectId,
        loopId,
        runId: claimed.runId,
        receipt: claimed.receipt,
        result: {
          kind: "final",
          status: "completed",
          report: "Not measured — synthetic test",
          error: null,
          article: null,
        },
      }),
    ).rejects.toThrow("loop_not_house");
    expect(mocks.cas).not.toHaveBeenCalled();
  });

  it("refuses mutation tools before reservation", async () => {
    houseTools();
    const claimed = await claimHouse();
    await expect(
      postSubscriptionLoopRequest({
        action: "tool",
        houseOnly: true,
        projectId,
        loopId,
        runId: claimed.runId,
        receipt: claimed.receipt,
        step: 1,
        tool: "propose_homegrown_otto_fixes",
        arguments: {},
      }),
    ).rejects.toThrow("tool_not_permitted");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.cas).not.toHaveBeenCalled();
  });

  it("guards final settlement against atomic scope changes", async () => {
    houseTools();
    const claimed = await claimHouse();
    mocks.cas.mockResolvedValue(false);
    await expect(
      postSubscriptionLoopRequest({
        action: "complete",
        houseOnly: true,
        projectId,
        loopId,
        runId: claimed.runId,
        receipt: claimed.receipt,
        result: {
          kind: "final",
          status: "completed",
          report: "Not measured — synthetic test",
          error: null,
          article: null,
        },
      }),
    ).rejects.toThrow("state_changed");
    expect(mocks.cas.mock.calls[0][4]).toEqual(scope);
  });
});
