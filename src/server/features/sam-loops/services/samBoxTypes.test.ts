import { describe, expect, it } from "vitest";
import {
  SAM_BOX_COST_PREFIX,
  SAM_BOX_KIND_LIMITS,
  SAM_BOX_KINDS,
  SAM_BOX_LEASE_SECONDS,
  SAM_BOX_MAX_OUTPUT_BYTES,
  SAM_BOX_MAX_PROMPT_BYTES,
  SAM_BOX_MAX_REPORT_CHARS,
} from "./samBoxTypes";

describe("Sam box shared limits", () => {
  it("keeps one limit table for both supported kinds", () => {
    expect(SAM_BOX_KINDS).toEqual(["on_page_priorities", "ctr_opportunities"]);
    expect(SAM_BOX_KIND_LIMITS).toEqual({
      on_page_priorities: {
        maxProposals: 5,
        allowedFields: ["title", "description", "h1"],
        titleMax: 70,
        descriptionMax: 170,
      },
      ctr_opportunities: {
        maxProposals: 3,
        allowedFields: ["title", "description"],
        titleMax: 60,
        descriptionMax: 155,
      },
    });
  });

  it("keeps the transport limits within the subscription runtime bounds", () => {
    expect(SAM_BOX_COST_PREFIX).toBe("box:grok-sub");
    expect(SAM_BOX_LEASE_SECONDS).toBe(900);
    expect(SAM_BOX_MAX_PROMPT_BYTES).toBe(28000);
    expect(SAM_BOX_MAX_OUTPUT_BYTES).toBe(24576);
    expect(SAM_BOX_MAX_REPORT_CHARS).toBe(6000);
  });
});
