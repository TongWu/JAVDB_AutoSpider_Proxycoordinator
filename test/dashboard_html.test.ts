import { describe, it, expect } from "vitest";
import { renderDashboardHtml } from "../src/dashboard_html";

describe("Phase 3 dashboard HTML — visibility-aware polling", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("declares the three poll intervals", () => {
    expect(html).toContain("VISIBLE_MS = 5000");
    expect(html).toContain("HIDDEN_MS = 30000");
    expect(html).toContain("PAUSE_AFTER_HIDDEN_MS = 1800000");
  });

  it("uses Page Visibility API", () => {
    expect(html).toContain("document.visibilityState");
    expect(html).toContain("visibilitychange");
  });

  it("does NOT use the old fixed setInterval pattern", () => {
    // We expect the new state-machine implementation, not setInterval(refresh, 30000)
    expect(html).not.toContain("setInterval(refresh, REFRESH_MS)");
    expect(html).not.toContain("setInterval(refresh,30000)");
  });

  it("schedules next tick via setTimeout, not setInterval", () => {
    // The state machine uses setTimeout for each tick so the interval
    // can change dynamically as visibility changes.
    expect(html).toContain("setTimeout(tick");
  });
});
