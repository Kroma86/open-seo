import { describe, expect, it, vi } from "vitest";
import {
  buildCitedSourceDecision,
  gradeCitedSources,
  JEV_DECISIONS_URL,
  JEV_MODEL,
} from "./jevCitedSources";
import {
  JEV_ABOUT_THIS_BUSINESS_QUESTION,
  newJevSpendBudget,
} from "@/shared/real-mentions";

describe("gradeCitedSources", () => {
  it("builds one zero-data-retention decision per cited source", () => {
    const body = buildCitedSourceDecision({
      businessName: "SSOCC",
      website: "ssocc.ca",
      brandQuery: "SSOCC",
      source: {
        url: "https://ssocc.ca/about",
        domain: "ssocc.ca",
        keywords: [{ question: "what is ssocc" }],
      },
    });

    expect(body.model).toBe(JEV_MODEL);
    expect(JEV_MODEL).toBe("typesafe/jev-1.13");
    expect(JEV_DECISIONS_URL).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(body.provider).toEqual({ zdr: true });
    expect(body.questions.q).toEqual({
      type: "noul",
      instructions: JEV_ABOUT_THIS_BUSINESS_QUESTION,
    });
    expect(body.state).toEqual({
      business: { name: "SSOCC", website: "ssocc.ca" },
      cited_source: {
        url: "https://ssocc.ca/about",
        domain: "ssocc.ca",
      },
      search_queries: ["what is ssocc"],
    });
    expect(JSON.stringify(body)).not.toContain("sk-");
  });

  it("stores p and counts only the sources at or above 0.5", async () => {
    const poster = vi.fn(async (body: unknown) => {
      const url = (body as { state: { cited_source: { url: string } } }).state
        .cited_source.url;
      const p = url.includes("ssocc.ca")
        ? 0.93
        : url.includes("cinnamoncounselling.ca")
          ? 0.71
          : 0.04;
      return {
        status: 200,
        json: {
          answers: { q: { type: "noul", noul: p } },
          usage: { cost: 0.000018 },
        },
      };
    });

    const result = await gradeCitedSources({
      businessName: "SSOCC",
      website: "ssocc.ca",
      apiKey: "test-key",
      poster,
      sources: [
        { url: "https://ssocc.ca/a", domain: "ssocc.ca" },
        { url: "https://ssocc.ca/b", domain: "ssocc.ca" },
        {
          url: "https://cinnamoncounselling.ca/sex-therapy",
          domain: "cinnamoncounselling.ca",
        },
        { url: "https://example.com/oopsie-daisy", domain: "example.com" },
      ],
    });

    expect(poster).toHaveBeenCalledTimes(4);
    expect(result.sources.map((source) => source.p)).toEqual([
      0.93, 0.93, 0.71, 0.04,
    ]);
    expect(result.realMentions).toBe(3);
    expect(result.real_mentions).toBe(3);
    expect(result.costUsd).toBeLessThanOrEqual(0.01);
    expect(result.capped).toBe(false);
  });

  it("stops before the next call once the run reaches $0.01", async () => {
    const poster = vi.fn(async () => ({
      status: 200,
      json: { answers: { q: { noul: 0.99 } }, usage: { cost: 0.004 } },
    }));
    const sources = Array.from({ length: 6 }, (_, index) => ({
      url: `https://example.com/${index}`,
      domain: "example.com",
    }));

    const result = await gradeCitedSources({
      businessName: "Acme",
      website: "acme.example",
      apiKey: "test-key",
      poster,
      sources,
    });

    expect(poster.mock.calls.length).toBeLessThanOrEqual(3);
    expect(result.costUsd).toBeLessThanOrEqual(0.01);
    expect(result.capped).toBe(true);
    expect(result.realMentions).toBeNull();
    expect(
      result.sources.filter((source) => source.p == null).length,
    ).toBeGreaterThan(0);
  });

  it("keeps a whole weekly pass inside one cent", async () => {
    const budget = newJevSpendBudget();
    const poster = vi.fn(async () => ({
      status: 200,
      json: { answers: { q: { noul: 0.1 } }, usage: { cost: 0.004 } },
    }));
    const source = (id: string) => ({
      url: `https://example.com/${id}`,
      domain: "example.com",
    });

    await gradeCitedSources({
      businessName: "One",
      website: "one.example",
      apiKey: "test-key",
      poster,
      budget,
      sources: [source("a"), source("b"), source("c")],
    });
    await gradeCitedSources({
      businessName: "Two",
      website: "two.example",
      apiKey: "test-key",
      poster,
      budget,
      sources: [source("d"), source("e")],
    });

    expect(budget.spentUsd).toBeLessThanOrEqual(0.01);
    expect(poster).toHaveBeenCalledTimes(2);
  });

  it("does not call out when the key is missing", async () => {
    const poster = vi.fn();
    const result = await gradeCitedSources({
      businessName: "Acme",
      website: "acme.example",
      apiKey: null,
      poster,
      sources: [{ url: "https://acme.example", domain: "acme.example" }],
    });
    expect(poster).not.toHaveBeenCalled();
    expect(result.unavailable).toBe(true);
    expect(result.realMentions).toBeNull();
    expect(result.calls).toBe(0);
  });

  it("keeps a failed call out of the yes count", async () => {
    const poster = vi.fn(async () => ({ status: 500, json: null }));
    const result = await gradeCitedSources({
      businessName: "Acme",
      website: "acme.example",
      apiKey: "test-key",
      poster,
      sources: [{ url: "https://acme.example/a", domain: "acme.example" }],
    });
    expect(result.sources[0]?.p).toBeNull();
    expect(result.realMentions).toBeNull();
    expect(result.costUsd).toBe(0);
  });
});
