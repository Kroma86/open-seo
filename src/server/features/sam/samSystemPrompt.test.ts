import { describe, expect, it } from "vitest";
import { buildSamSystemPrompt } from "./samSystemPrompt";

const project = {
  projectId: "p1",
  projectName: "Home Care Solutions",
  domain: "homecaresolutions.ca",
  locationCode: 2124,
  languageCode: "en",
};

describe("buildSamSystemPrompt intake mode", () => {
  it("parks inferred facts in intake-draft and never saves them as business facts right away", () => {
    const prompt = buildSamSystemPrompt(project, { intakeMode: true });
    expect(prompt).toContain("intake-draft");
    expect(prompt).toContain("until the user confirms it in chat");
    expect(prompt).not.toContain("Save what you inferred right away");
  });

  it("forbids off-site pages as a source for this project's facts", () => {
    const prompt = buildSamSystemPrompt(project, { intakeMode: true });
    expect(prompt).toContain(
      "Read only the project website for business facts",
    );
    expect(prompt).toContain("marked offsite");
    expect(prompt).toContain("even when the names match");
  });

  it("keeps the intake block out of normal mode", () => {
    const prompt = buildSamSystemPrompt(project, { intakeMode: false });
    expect(prompt).not.toContain("intake-draft");
    expect(prompt).toContain("Project website: homecaresolutions.ca");
  });
});
