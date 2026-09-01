import { describe, expect, it } from "vitest";
import { buildSamSkillSource } from "@/server/features/sam/samSkills";
import { buildSamSystemPrompt } from "@/server/features/sam/samSystemPrompt";

describe("buildSamSkillSource", () => {
  // Guards the real failure modes: a skill whose frontmatter breaks (build
  // throws), an internal repo-dev skill leaking into SAM, or the public set
  // silently shrinking because a glob or marking change dropped it.
  it("serves exactly the public product skills", async () => {
    const source = buildSamSkillSource();
    const names = (await source.list()).map((skill) => skill.name);

    expect(names).toEqual([
      "ai-visibility",
      "authority-plan",
      "brand-facts",
      "competitive-landscape",
      "competitor-analysis",
      "content-brief",
      "content-draft",
      "content-topical-map",
      "homegrown-otto",
      "keyword-clustering",
      "keyword-gap",
      "keyword-research",
      "link-prospecting",
      "local-seo",
      "location-pages",
      "niceseo-pillars",
      "not-in-openseo",
      "page-growth",
      "page-pruning",
      "rank-slippage",
      "sales-proposal",
      "seo-audit",
      "seo-coach",
      "seo-project-setup",
      "site-health",
      "striking-distance",
    ]);

    const loaded = await source.load("seo-project-setup");
    expect(loaded?.body).toContain("Surface note: you are SAM");

    const pageGrowth = await source.load("page-growth");
    expect(pageGrowth?.body).toContain("niceseo.ai");
    expect(pageGrowth?.body).toContain("twa.studio");
    expect(pageGrowth?.body).toContain("dogfooding");
    const refuse = await source.load("not-in-openseo");
    expect(refuse?.body).toContain("Cloud Stacks");
    expect(refuse?.body).toContain("Google Ads");

    const pillars = await source.load("niceseo-pillars");
    expect(pillars?.body).toContain("lighthouseSeoAvg");
    expect(pillars?.body).toContain("100 − position");
    expect(pillars?.body).toContain("20 × log10");
    expect(pillars?.body).toContain("onpage_basics");
    expect(pillars?.body).toContain("Never put 100 in the ring");
    expect(pillars?.body).toContain("lighthouse_seo_checklist");
  });

  it("puts pillar formulas in SAM's always-on prompt", () => {
    const prompt = buildSamSystemPrompt(
      {
        projectId: "p1",
        projectName: "niceseo.ai",
        domain: "niceseo.ai",
        locationCode: 2840,
        languageCode: "en",
      },
      { intakeMode: false },
    );
    expect(prompt).toContain("NICESEO PILLAR LAW");
    expect(prompt).toContain("lighthouseSeoAvg");
    expect(prompt).toContain("100 − position");
    expect(prompt).toContain("onpage_basics");
  });
});
