import { describe, expect, it } from "vitest";
import { hasVerifiedMonthlyDraft, stripDraftEvidence, validateMonthlyContent } from "./monthlyContentResult";

const url = "https://example.com/services/drains";
const page = "Example Plumbing clears blocked household drains. The team first inspects the blockage and explains the proposed repair.";
const paragraph = "A careful inspection helps explain where a blockage began and what the next step should be. Homeowners can write down when they first noticed slow drainage and describe which fixtures are affected. This gives the team useful context before it inspects the drain. Avoid guessing about the cause before the inspection is complete. Keep a clear record of the symptoms so the proposed repair can be discussed in the context of what was observed. ";
const article = { outcome: "draft", reason: "", targetKeyword: "drain cleaning", title: "Understanding a drain inspection", body: Array.from({ length: 5 }, (_, i) => `## Part ${i + 1}\n\n${paragraph.repeat(2)}`).join("\n\n"), sources: [{ url, excerpt: "Example Plumbing clears blocked household drains." }] };
const source = { toolName: "read_pages", output: { blocked: false, pages: [{ url, title: "Drains", text: page }] } };
const saved = { toolName: "list_saved_keywords", output: { data: { rows: [{ keyword: "drain cleaning" }] } } };
const tracked = { toolName: "get_rank_tracker", output: { data: { results: { rows: [{ keyword: "drain cleaning" }], run: null } } } };
const query = { toolName: "get_search_console_performance", output: { data: { ok: true, dimensions: ["page", "query"], rows: [{ keys: [url, "drain cleaning"] }] } } };

describe("monthly draft evidence", () => {
  it.each([saved, tracked, query])("accepts a retrieved topic and own-site supporting page", async (demand) => {
    const result = await validateMonthlyContent(article, [{ toolResults: [demand, source] }], "example.com");
    expect(result.error).toBeNull();
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(true);
    expect(stripDraftEvidence(result.report)).toContain(article.body.trim());
    expect(stripDraftEvidence(result.report)).not.toContain("openseo-monthly-draft-v1");
    expect(await hasVerifiedMonthlyDraft(result.report.replace("Understanding", "Changed"))).toBe(false);
  });
  it("can use saved demand when Search Console is disconnected", async () => {
    const result = await validateMonthlyContent(article, [{ toolResults: [saved, source, { toolName: "get_search_console_performance", output: { data: { ok: false, reason: "not_connected" } } }] }], "example.com");
    expect(result.error).toBeNull();
  });
  it("keeps supporting evidence from an earlier read of the same URL", async () => {
    const laterRead = {
      toolName: "read_pages",
      output: {
        blocked: false,
        pages: [{ url, text: "The service page has changed since the first read. It now explains how appointments are arranged and how to prepare for a visit." }],
      },
    };
    const result = await validateMonthlyContent(article, [
      { toolResults: [saved, source] },
      { toolResults: [laterRead] },
    ], "example.com");
    expect(result.error).toBeNull();
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(true);
  });
  it.each([
    {
      label: "invalid source URL",
      source: { url: "https://elsewhere.example/drains", excerpt: article.sources[0]!.excerpt },
      error: "A supporting source URL is invalid or does not belong to this site.",
    },
    {
      label: "unread source URL",
      source: { url: "https://example.com/unread", excerpt: article.sources[0]!.excerpt },
      error: "A supporting source URL was not read during this run.",
    },
    {
      label: "short excerpt",
      source: { url, excerpt: "Example Plumbing" },
      error: "A supporting source excerpt is shorter than 30 characters.",
    },
    {
      label: "unsupported excerpt",
      source: { url, excerpt: "We guarantee the cheapest price in the province." },
      error: "A supporting source excerpt was not found in any page snapshot read during this run.",
    },
  ])("reports $label without exposing source or article contents", async (candidate) => {
    const result = await validateMonthlyContent(
      { ...article, sources: [candidate.source] },
      [{ toolResults: [saved, source] }],
      "example.com",
    );
    expect(result.error).toBe(candidate.error);
    expect(result.report).toBe(`Monthly article not completed: ${candidate.error}`);
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(false);
  });
  it("does not join separate page snapshots to manufacture a supporting excerpt", async () => {
    const firstHalf = "A careful inspection identifies";
    const secondHalf = " the next practical repair step.";
    const result = await validateMonthlyContent(
      { ...article, sources: [{ url, excerpt: firstHalf + secondHalf }] },
      [{ toolResults: [saved, {
        toolName: "read_pages",
        output: { blocked: false, pages: [
          { url, text: `${"Background information about the service. ".repeat(3)}${firstHalf}` },
          { url, text: `${secondHalf}${" Further details explain how visits are arranged.".repeat(3)}` },
        ] },
      }] }],
      "example.com",
    );
    expect(result.error).toBe("A supporting source excerpt was not found in any page snapshot read during this run.");
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(false);
  });
  it.each([
    { ...article, targetKeyword: "invented target" },
    { ...article, title: "" },
    { ...article, body: "## Outline\n\n- Planned heading\n- Planned heading" },
    { ...article, sources: [] },
    { ...article, sources: [{ url: "https://elsewhere.example/drains", excerpt: page }] },
    { ...article, sources: [{ url, excerpt: "We guarantee the cheapest price in the province." }] },
    { ...article, outcome: "blocked", reason: "No saved demand" },
    null,
  ])("rejects incomplete or invented evidence", async (candidate) => {
    const result = await validateMonthlyContent(candidate, [{ toolResults: [saved, source] }], "example.com");
    expect(result.error).not.toBeNull();
    expect(await hasVerifiedMonthlyDraft(result.report)).toBe(false);
  });
  it.each([
    { toolResults: [] },
    { toolResults: [{ toolName: "list_saved_keywords", output: { error: "unavailable", data: { rows: [{ keyword: "drain cleaning" }] } } }, source] },
    { toolResults: [saved, { toolName: "read_pages", output: { blocked: true, pages: [{ url, text: page }] } }] },
    { toolResults: [saved, { toolName: "read_pages", output: { blocked: false, pages: [] } }] },
    { toolResults: [source] },
  ])("requires successful tool evidence from this run", async ({ toolResults }) => {
    const result = await validateMonthlyContent(article, [{ toolResults }], "example.com");
    expect(result.error).not.toBeNull();
  });
  it.each(["No draft produced", "# DRAFT\nAn outline", "", null, "<!-- openseo-monthly-draft-v1:" + "a".repeat(64) + " -->"])("does not count legacy prose or a forged heading as an article", async (report) => {
    expect(await hasVerifiedMonthlyDraft(report)).toBe(false);
  });
});
