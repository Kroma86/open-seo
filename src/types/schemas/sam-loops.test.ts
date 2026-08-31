import { describe, expect, it } from "vitest";
import { createSamLoopSchema } from "@/types/schemas/sam-loops";

describe("createSamLoopSchema", () => {
  it("requires skillName for skill source", () => {
    const result = createSamLoopSchema.safeParse({
      projectId: "11111111-1111-4111-8111-111111111111",
      name: "Health",
      sourceType: "skill",
      cadence: "weekly",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a skill-backed loop", () => {
    const result = createSamLoopSchema.safeParse({
      projectId: "11111111-1111-4111-8111-111111111111",
      name: "Health",
      sourceType: "skill",
      skillName: "site-health",
      cadence: "weekly",
    });
    expect(result.success).toBe(true);
  });

  it("requires customPrompt for custom source", () => {
    const result = createSamLoopSchema.safeParse({
      projectId: "11111111-1111-4111-8111-111111111111",
      name: "Ad hoc",
      sourceType: "custom",
      cadence: "daily",
    });
    expect(result.success).toBe(false);
  });
});
