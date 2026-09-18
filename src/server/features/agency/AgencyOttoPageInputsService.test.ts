import { beforeEach, describe, expect, it, vi } from "vitest";

// Rows here mirror real board data from 2026-09-18, when 18 of 39 clients had
// their "homepage" SEO checks scored against the wrong page. Two of them were
// scored against a different domain entirely.

const queue: unknown[][] = [];

function builder() {
  const b: Record<string, unknown> = {};
  const self = () => b;
  b.from = self;
  b.where = self;
  b.orderBy = self;
  b.limit = self;
  b.then = (
    resolve: (value: unknown) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(queue.shift() ?? []).then(resolve, reject);
  return b;
}

vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  asc: () => ({}),
  eq: () => ({}),
  inArray: () => ({}),
  isNull: () => ({}),
}));
vi.mock("@/db", () => ({ db: { select: () => builder() } }));
vi.mock("@/db/schema", () => ({
  auditPages: {
    url: {},
    statusCode: {},
    title: {},
    metaDescription: {},
    canonicalUrl: {},
    ogTitle: {},
    ogDescription: {},
    h1Count: {},
    wordCount: {},
    imagesMissingAlt: {},
    crawlDepth: {},
    auditId: {},
    fetchClass: {},
  },
  projects: { organizationId: {}, archivedAt: {}, domain: {}, name: {} },
}));

const audit: { id: string; startUrl: string | null; completedAt: string | null; startedAt: string | null } =
  { id: "a1", startUrl: null, completedAt: "2026-09-17T04:26:06Z", startedAt: null };

vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: { getLatestAuditForProject: async () => audit },
}));

const { getAgencyOttoPageInputs } = await import(
  "./AgencyOttoPageInputsService"
);

const page = (url: string) => ({
  url,
  statusCode: 200,
  title: url,
  metaDescription: "d",
  canonicalUrl: url,
  ogTitle: null,
  ogDescription: null,
  h1Count: 1,
  wordCount: 400,
  imagesMissingAlt: 0,
  crawlDepth: 0,
});

const ROOTS = new Set(
  ["https://", "http://"].flatMap((s) =>
    ["", "www."].flatMap((w) => [s + w, s + w]),
  ),
);

function isRootUrl(url: string) {
  try {
    const u = new URL(url);
    return u.pathname === "/" && !u.search;
  } catch {
    return false;
  }
}

/**
 * Three queries run in order: the project row, the limited page window, then
 * the dedicated root lookup. `windowUrls` is what the paged query returns and
 * `allUrls` is everything the audit holds — they differ because the root sorts
 * behind every null-depth row and falls outside the window.
 */
function seed(
  domain: string,
  windowUrls: string[],
  startUrl: string | null = null,
  allUrls: string[] = windowUrls,
) {
  void ROOTS;
  audit.startUrl = startUrl;
  queue.length = 0;
  queue.push([{ id: "p1", name: domain, domain, organizationId: null }]);
  queue.push([...windowUrls].sort().map(page));
  queue.push(allUrls.filter(isRootUrl).map(page));
}

beforeEach(() => {
  queue.length = 0;
  audit.startUrl = null;
});

describe("homepage selection", () => {
  it("returns the root page of the project's own domain", async () => {
    seed("millcreekbakery.ca", [
      "https://millcreekbakery.ca/about",
      "https://millcreekbakery.ca/",
    ]);
    const out = await getAgencyOttoPageInputs({ domain: "millcreekbakery.ca" });
    expect(out.homepage?.path).toBe("/");
    expect(out.homepageReason).toBe("ok");
  });

  it("treats www as the same domain", async () => {
    seed("millcreekbakery.ca", ["https://www.millcreekbakery.ca/"]);
    const out = await getAgencyOttoPageInputs({ domain: "millcreekbakery.ca" });
    expect(out.homepage?.path).toBe("/");
    expect(out.homepageReason).toBe("ok");
  });

  // The regression. Ordering is `asc(crawlDepth), asc(url)`, so when the root
  // page is absent the old `?? pages[0]` fallback returned whichever path
  // sorted first and called it the homepage.
  it("returns null, not the alphabetically-first page, when the root was not crawled", async () => {
    seed("veruminnovations.com", [
      "https://veruminnovations.com/about",
      "https://veruminnovations.com/services",
    ]);
    const out = await getAgencyOttoPageInputs({
      domain: "veruminnovations.com",
    });
    expect(out.homepage).toBeNull();
    expect(out.homepageReason).toBe("root_not_in_audit");
  });

  it("does not accept an underscore-prefixed platform endpoint as the homepage", async () => {
    seed("fenskefinancialcoaching.com", [
      "https://www.fenskefinancialcoaching.com/_serverless/challenges-web-serverless/redirect-invite-link?programId=15fe39c6",
      "https://www.fenskefinancialcoaching.com/blog",
    ]);
    const out = await getAgencyOttoPageInputs({
      domain: "fenskefinancialcoaching.com",
    });
    expect(out.homepage).toBeNull();
    expect(out.homepageReason).toBe("root_not_in_audit");
  });

  // wellhealthcounselling.com was being scored against consciouspathcounselling.ca.
  it("rejects pages belonging to a different domain", async () => {
    seed("wellhealthcounselling.com", [
      "https://consciouspathcounselling.ca/",
      "https://consciouspathcounselling.ca/about",
    ]);
    const out = await getAgencyOttoPageInputs({
      domain: "wellhealthcounselling.com",
    });
    expect(out.homepage).toBeNull();
    expect(out.homepageReason).toBe("no_pages_on_project_domain");
  });

  it("ignores a start URL that points at another domain", async () => {
    seed(
      "cinnamoncounselling.ca",
      ["https://cinnamoncounselling.ca/adhd-coaching"],
      "https://cinnamoncounselling.com/adhd-coaching",
    );
    const out = await getAgencyOttoPageInputs({
      domain: "cinnamoncounselling.ca",
    });
    expect(out.homepage).toBeNull();
    expect(out.homepageReason).toBe("root_not_in_audit");
  });

  it("honours a start URL on the project's own domain", async () => {
    seed(
      "example.ca",
      ["https://example.ca/en/", "https://example.ca/about"],
      "https://example.ca/en/",
    );
    const out = await getAgencyOttoPageInputs({ domain: "example.ca" });
    expect(out.homepage?.path).toBe("/en/");
    expect(out.homepageReason).toBe("ok");
  });

  // The root is stored with crawlDepth 0 while every other page has a null
  // depth. SQLite sorts nulls first on ASC, so the root sits behind all of
  // them and never appears in the limited page window.
  it("finds the root even when it falls outside the paged window", async () => {
    seed(
      "veruminnovations.com",
      [
        "https://veruminnovations.com/about",
        "https://veruminnovations.com/blog",
      ],
      null,
      [
        "https://veruminnovations.com/",
        "https://veruminnovations.com/about",
        "https://veruminnovations.com/blog",
      ],
    );
    const out = await getAgencyOttoPageInputs({
      domain: "veruminnovations.com",
    });
    expect(out.homepage?.url).toBe("https://veruminnovations.com/");
    expect(out.homepageReason).toBe("ok");
  });

  it("reports when nothing was crawled at all", async () => {
    seed("example.ca", []);
    const out = await getAgencyOttoPageInputs({ domain: "example.ca" });
    expect(out.homepage).toBeNull();
    expect(out.homepageReason).toBe("no_pages_crawled");
  });
});
