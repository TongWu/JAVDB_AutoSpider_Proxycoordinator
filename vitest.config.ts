import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            PROXY_COORDINATOR_TOKEN: "test-token",
            NUM_CLAIM_SHARDS: "1",
            // W5.1 — dashboard password seeded for the login-flow tests.
            DASHBOARD_PASSWORD: "test-dash-password",
          },
        },
      },
    },
  },
});
