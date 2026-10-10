import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import { onPageExecutionPrompt } from "./onPageExecutionPrompt";

const template = DEFAULT_SAM_LOOP_TEMPLATES.find(
  (row) => row.name === "On-page priorities",
);
if (!template) throw new Error("Missing on-page fixture template");
const originalPrompt = template.customPrompt;

afterEach(() => {
  Object.assign(template, { customPrompt: originalPrompt });
});

describe("onPageExecutionPrompt", () => {
  it("keeps the original execution text while removing the stored cadence skip", () => {
    const body = originalPrompt.slice(
      originalPrompt.indexOf("Queue-only on-page pass"),
    );
    expect(onPageExecutionPrompt(originalPrompt)).toBe(
      [
        "Perform this pass on every scheduled run. The configured cadence controls timing.",
        "First list existing proposals. Skip a page/field when the same replacement is already pending or approved.",
        body,
      ].join("\n\n"),
    );
  });

  it("returns custom and other template prompts byte-for-byte", () => {
    const custom = `${originalPrompt} `;
    expect(onPageExecutionPrompt(custom)).toBe(custom);
    expect(onPageExecutionPrompt("An unrelated custom prompt\n")).toBe(
      "An unrelated custom prompt\n",
    );
    const ctr = DEFAULT_SAM_LOOP_TEMPLATES.find(
      (row) => row.name === "CTR opportunities",
    );
    if (!ctr) throw new Error("Missing CTR fixture template");
    expect(onPageExecutionPrompt(ctr.customPrompt)).toBe(ctr.customPrompt);
  });

  it("preserves the missing execution-template error", () => {
    Object.assign(template, { customPrompt: "Broken reserved identity" });
    expect(() => onPageExecutionPrompt("Broken reserved identity")).toThrow(
      "On-page execution template is missing",
    );
  });
});
