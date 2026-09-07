import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crawlPage } from "./site-audit-workflow-helpers";

afterEach(() => vi.unstubAllGlobals());

describe("crawlPage", () => {
  it("preserves extracted metadata and nested values when releasing the HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `<html><head>
            <title>Example &amp; café 🌱</title>
            <meta name="description" content="Example description &amp; more">
            <meta name="robots" content="noindex">
            <meta property="og:title" content="Example social title 🌱">
            <meta property="og:description" content="Example description">
            <meta property="og:image" content="/social.png">
            <link rel="canonical" href="/canonical">
            <link rel="alternate" hreflang="en" href="/en">
            <script type="application/ld+json">{}</script>
          </head><body><h1>Hello</h1><h2>World</h2>
            <img src="/photo.png" alt="Example photo 🌱"><img src="/missing.png">
            <img alt="">
            <a href="/next" rel="nofollow">More &amp; more 🌱</a>
            <a href="https://other.example/">External</a>
          </body></html>`,
          {
            headers: {
              "content-type": "text/html",
              "x-robots-tag": "nofollow",
              link: '<https://example.com/header>; rel="canonical"',
            },
          },
        ),
      ),
    );

    const page = await crawlPage("https://example.com/", 2, true);

    expect(page).toMatchObject({
      url: "https://example.com/",
      statusCode: 200,
      fetchClass: "ok",
      redirectUrl: null,
      title: "Example & café 🌱",
      metaDescription: "Example description & more",
      canonicalUrl: "https://example.com/canonical",
      robotsMeta: "noindex",
      xRobotsTag: "nofollow",
      headerCanonicalUrl: "https://example.com/header",
      ogTitle: "Example social title 🌱",
      ogDescription: "Example description",
      ogImage: "/social.png",
      h1Count: 1,
      h2Count: 1,
      h3Count: 0,
      headingOrder: [1, 2],
      isHtml: true,
      imagesTotal: 3,
      imagesMissingAlt: 1,
      images: [
        { src: "/photo.png", alt: "Example photo 🌱" },
        { src: "/missing.png", alt: null },
        { src: null, alt: "" },
      ],
      links: [
        {
          targetUrl: "https://example.com/next",
          anchor: "More & more 🌱",
          isInternal: true,
          isNofollow: true,
        },
        {
          targetUrl: "https://other.example/",
          anchor: "External",
          isInternal: false,
          isNofollow: false,
        },
      ],
      hasStructuredData: true,
      hreflangTags: ["en"],
      isIndexable: false,
      crawlDepth: 2,
      inSitemap: true,
    });
    expect(page.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(page.htmlBytes).toBeGreaterThan(0);
  });

  it("does not retain large source HTML in queued crawl results", () => {
    // A dedicated V8 process makes GC available without depending on the test
    // runner's heap. Exercise the real reader/parser with separate streamed
    // bodies; keeping just their titles used to retain every 1 MiB document.
    const result = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { crawlPage } from ${JSON.stringify(new URL("./site-audit-workflow-helpers.ts", import.meta.url).href)};
          globalThis.fetch = async () => {
            const html = '<title>Example memory regression 🌱</title>' +
              '<meta name="description" content="A small description">' +
              '<script>' + 'x'.repeat(1024 * 1024) + '</script>';
            const bytes = new TextEncoder().encode(html);
            let offset = 0;
            return new Response(new ReadableStream({
              pull(controller) {
                if (offset >= bytes.length) return controller.close();
                controller.enqueue(bytes.subarray(offset, offset + 65536));
                offset += 65536;
              },
            }), { headers: { "content-type": "text/html" } });
          };
          const collect = async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
            globalThis.gc();
            globalThis.gc();
            const { heapUsed, external } = process.memoryUsage();
            return heapUsed + external;
          };
          await crawlPage("https://example.com/warmup", 0, true);
          const before = await collect();
          const pages = [];
          for (let i = 0; i < 50; i++) {
            pages.push(await crawlPage("https://example.com/" + i, 0, true));
          }
          const retained = (await collect()) - before;
          assert.equal(pages.length, 50);
          assert.equal(pages[49].title, "Example memory regression 🌱");
          assert.ok(retained < 16 * 1024 * 1024,
            "Queued results retained " + retained + " bytes of source HTML");
        `,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 25_000);
});
