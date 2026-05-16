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

describe("Phase 3 — browser timezone formatting", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("uses Intl.DateTimeFormat with timeZoneName: 'short'", () => {
    expect(html).toContain("timeZoneName");
    expect(html).toContain("Intl.DateTimeFormat");
  });

  it("removes the legacy fmtTs that used toISOString + 'Z' suffix", () => {
    // Old: toISOString().replace("T", " ").slice(11,19) + "Z"
    expect(html).not.toContain('.slice(11,19) + "Z"');
  });

  it("renders hover tooltips with title attributes for time fields", () => {
    // The runners render emits something like:
    //   <span title="...absolute time..."> 5s ago </span>
    // The signals render does the same.
    // We just check that title="..." appears in the rendered HTML.
    // (The actual title content is dynamic JS, but the pattern "title=" appears
    // inside an esc()-wrapped attribute.)
    expect(html).toMatch(/title="[^"]*' \+ esc\(/);
  });

  it("topbar ts has a tooltip span (innerHTML, not textContent)", () => {
    // Verify $("ts").innerHTML = ... pattern instead of textContent
    expect(html).toMatch(/\$\("ts"\)\.innerHTML\s*=/);
  });
});
