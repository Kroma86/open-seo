import { describe, expect, it } from "vitest";
import {
  countProposalsQueued,
  isSuccessfulProposeOutput,
} from "./countProposalsQueued";

describe("countProposalsQueued", () => {
  it("counts only successful propose tool results", () => {
    const steps = [
      {
        toolResults: [
          {
            toolName: "propose_homegrown_otto_fixes",
            output: {
              summary: "Queued HomeGrown OTTO proposal abc for example.com/.",
              data: { id: "prop_1" },
            },
          },
          {
            toolName: "propose_homegrown_otto_fixes",
            output: { error: "VALIDATION_ERROR: missing title" },
          },
          {
            toolName: "get_audit_issues",
            output: { summary: "3 issues" },
          },
        ],
      },
      {
        toolResults: [
          {
            toolName: "propose_homegrown_otto_fixes",
            output: {
              summary:
                "Queued HomeGrown OTTO proposal def for example.com/about.",
              data: { id: "prop_2" },
            },
          },
        ],
      },
    ];

    expect(countProposalsQueued(steps)).toBe(2);
  });

  it("does not inflate the count for failed propose calls", () => {
    expect(
      countProposalsQueued([
        {
          toolResults: [
            {
              toolName: "propose_homegrown_otto_fixes",
              output: { error: "UPSTREAM_UNAVAILABLE" },
            },
          ],
        },
      ]),
    ).toBe(0);
  });

  it("ignores steps with no successful propose results", () => {
    expect(countProposalsQueued([{ toolResults: [] }])).toBe(0);
  });
});

describe("isSuccessfulProposeOutput", () => {
  it("rejects error-shaped outputs", () => {
    expect(isSuccessfulProposeOutput({ error: "nope" })).toBe(false);
    expect(isSuccessfulProposeOutput(null)).toBe(false);
  });

  it("accepts queued proposal payloads", () => {
    expect(
      isSuccessfulProposeOutput({
        summary: "Queued HomeGrown OTTO proposal x",
        data: { id: "prop_x" },
      }),
    ).toBe(true);
  });
});
