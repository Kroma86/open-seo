import { describe, expect, it } from "vitest";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import { samBoxKindForLoop } from "./samBoxKinds";

describe("samBoxKindForLoop", () => {
  it.each([
    ["On-page priorities", "on_page_priorities"],
    ["CTR opportunities", "ctr_opportunities"],
  ])("identifies %s only by its custom template bytes", (name, kind) => {
    const template = DEFAULT_SAM_LOOP_TEMPLATES.find(
      (row) => row.name === name,
    );
    if (!template || !("customPrompt" in template)) {
      throw new Error(`Missing fixture template: ${name}`);
    }
    expect(samBoxKindForLoop(template)).toBe(kind);
    const renamedLoop = { ...template, name: "Renamed loop" };
    expect(samBoxKindForLoop(renamedLoop)).toBe(kind);
    expect(
      samBoxKindForLoop({
        ...template,
        customPrompt: `${template.customPrompt} `,
      }),
    ).toBeNull();
    expect(samBoxKindForLoop({ ...template, sourceType: "skill" })).toBeNull();
  });

  it("rejects other templates and prompts even with a box display name", () => {
    for (const template of DEFAULT_SAM_LOOP_TEMPLATES) {
      if (
        template.name === "On-page priorities" ||
        template.name === "CTR opportunities"
      ) {
        continue;
      }
      expect(
        samBoxKindForLoop({
          sourceType: template.sourceType,
          customPrompt:
            "customPrompt" in template ? template.customPrompt : null,
        }),
      ).toBeNull();
    }
    const editedLoop = {
      name: "On-page priorities",
      sourceType: "custom",
      customPrompt: "A different prompt",
    };
    expect(samBoxKindForLoop(editedLoop)).toBeNull();
    expect(
      samBoxKindForLoop({ sourceType: "custom", customPrompt: null }),
    ).toBeNull();
  });
});
