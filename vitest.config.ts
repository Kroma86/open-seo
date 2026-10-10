import { defineConfig } from "vitest/config";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsConfigPaths()],
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "alchemy.access.test.ts",
      "scripts/**/*.test.mjs",
    ],
    restoreMocks: true,
    clearMocks: true,
    // Default is 5 s. samBoxPrepare's 28 KB truncation test takes ~2.7 s alone and
    // timed out on loaded CI runners; its quadratic truncation is tracked separately.
    testTimeout: 15_000,
    server: {
      deps: {
        // Processed by vitest (instead of loaded natively by node) so the
        // oauth-refresh e2e test's cloudflare:workers mock reaches the real
        // provider module.
        inline: ["@cloudflare/workers-oauth-provider"],
      },
    },
  },
});
