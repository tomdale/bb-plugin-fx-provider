import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The SDK's fake plugin host bundle pulls in CommonJS and native
    // dependencies (better-sqlite3); let Node resolve it instead of Vite.
    server: { deps: { external: ["@get-bb/plugin-sdk/testing"] } },
    // Bridges spawned by tests inherit this environment. Model discovery reads
    // the Gateway catalog from fx's loopback override, so pointing it at a
    // closed port keeps the suite off the network; tests that need a catalog
    // serve one locally and set their own URL.
    env: { FX_GATEWAY_BASE_URL: "http://127.0.0.1:9" },
  },
});
