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
            // ADR-043 D7 — the production breaker runs a 300 s window and a
            // 15 min TTL, which no test can wait out. These shrink both while
            // preserving the relationship production relies on (TTL > window,
            // so the latch can never expire while the window still holds a
            // quorum). Long enough that the multi-step "stays tripped" tests
            // never race the TTL; short enough that the expiry test costs
            // ~3 s. The trip/expiry *decision* is additionally covered
            // deterministically by the pure-function unit tests in
            // test/site_challenge.test.ts.
            SITE_CHALLENGE_WINDOW_SEC: "2",
            SITE_CHALLENGE_TTL_MS: "3000",
          },
        },
      },
    },
  },
});
