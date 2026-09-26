import { describe, expect, it } from "vitest";
import {
  formatOwnSiteCitations,
  hostIsOwnSite,
  normalizeCitationHost,
  summarizeOwnSiteCitations,
} from "@/shared/ai-visibility-citations";

describe("normalizeCitationHost", () => {
  it("strips scheme, www, path, and port", () => {
    expect(normalizeCitationHost("https://www.Acme.com/pricing")).toBe(
      "acme.com",
    );
    expect(normalizeCitationHost("blog.acme.com:443")).toBe("blog.acme.com");
  });
});

describe("hostIsOwnSite", () => {
  it("accepts the site and its subdomains only", () => {
    expect(hostIsOwnSite("acme.com", "acme.com")).toBe(true);
    expect(hostIsOwnSite("blog.acme.com", "acme.com")).toBe(true);
    expect(hostIsOwnSite("acme.com.evil.com", "acme.com")).toBe(false);
    expect(hostIsOwnSite("notacme.com", "acme.com")).toBe(false);
  });
});

describe("summarizeOwnSiteCitations", () => {
  const prompts = [
    {
      results: [
        {
          status: "success",
          citations: [{ domain: "www.acme.com" }],
        },
      ],
    },
    {
      results: [
        {
          status: "success",
          citations: [{ url: "https://unrelated.example/page" }],
        },
      ],
    },
    {
      results: [
        {
          status: "success",
          citations: [{ domain: "news.acme.com" }],
        },
      ],
    },
    {
      results: [{ status: "error", citations: [] }],
    },
  ];

  it("counts answers that link to the project's site, not loose word matches", () => {
    expect(summarizeOwnSiteCitations(prompts, "https://www.acme.com/")).toEqual(
      {
        ownSiteCitationCount: 2,
        ownSiteCitationSharePct: 66.7,
        ownSiteCitationsChecked: 3,
      },
    );
  });

  it("keeps a measured zero instead of pretending it was not checked", () => {
    expect(
      summarizeOwnSiteCitations(
        [
          {
            results: [
              { status: "success", citations: [{ domain: "other.com" }] },
            ],
          },
        ],
        "acme.com",
      ),
    ).toEqual({
      ownSiteCitationCount: 0,
      ownSiteCitationSharePct: 0,
      ownSiteCitationsChecked: 1,
    });
  });

  it("stays unmeasured when no answer succeeded or the site is unknown", () => {
    expect(
      summarizeOwnSiteCitations(
        [{ results: [{ status: "error", citations: [] }] }],
        "acme.com",
      ),
    ).toEqual({
      ownSiteCitationCount: null,
      ownSiteCitationSharePct: null,
      ownSiteCitationsChecked: null,
    });
    expect(summarizeOwnSiteCitations(prompts, null)).toEqual({
      ownSiteCitationCount: null,
      ownSiteCitationSharePct: null,
      ownSiteCitationsChecked: null,
    });
    expect(summarizeOwnSiteCitations(null, "acme.com")).toEqual({
      ownSiteCitationCount: null,
      ownSiteCitationSharePct: null,
      ownSiteCitationsChecked: null,
    });
  });
});

describe("formatOwnSiteCitations", () => {
  it("shows count and share, and never the word mentions", () => {
    const label = formatOwnSiteCitations({
      ownSiteCitationCount: 2,
      ownSiteCitationSharePct: 66.7,
      ownSiteCitationsChecked: 3,
    });
    expect(label).toBe("2 of 3 (66.7%)");
    expect(label.toLowerCase()).not.toContain("mention");
  });

  it("says not measured instead of zero when the check did not run", () => {
    expect(
      formatOwnSiteCitations({
        ownSiteCitationCount: null,
        ownSiteCitationSharePct: null,
        ownSiteCitationsChecked: null,
      }),
    ).toBe("not measured");
  });
});
