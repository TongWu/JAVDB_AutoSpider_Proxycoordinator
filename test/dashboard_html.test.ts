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

describe("Phase 3 — Config panel always shows merged config", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("renderConfig iterates over data.config.merged (not just values)", () => {
    expect(html).toContain("data.config.merged");
  });

  it("renderConfig branches on entry.source === 'override'", () => {
    expect(html).toMatch(/entry\.source === ['"]override['"]/);
  });

  it("renderConfig does NOT depend on data.config.values anymore", () => {
    // The old code path checked entries.length on data.config.values and
    // showed the "No operator overrides" hint. Confirm we don't still do that.
    expect(html).not.toContain("No operator overrides");
  });
});

describe("Phase 3 — per-proxy chip filter", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("has a chip-filter container above the proxy table", () => {
    expect(html).toContain('id="proxy-chips"');
  });

  it("declares localStorage key for filter state", () => {
    expect(html).toContain('PROXY_FILTER_KEY = "dashboard.proxyFilter"');
  });

  it("renders all / none / invert toggle buttons", () => {
    expect(html).toContain('data-chip-action="all"');
    expect(html).toContain('data-chip-action="none"');
    expect(html).toContain('data-chip-action="invert"');
  });

  it("renderProxyChips function is defined", () => {
    expect(html).toContain("function renderProxyChips(");
  });

  it("colorForProxy generates stable HSL colours", () => {
    expect(html).toContain("function colorForProxy(");
    expect(html).toContain("hsl(");
  });

  it("uses localStorage for chip filter persistence", () => {
    expect(html).toContain("localStorage.getItem(PROXY_FILTER_KEY)");
    expect(html).toContain("localStorage.setItem(PROXY_FILTER_KEY");
  });
});

describe("Phase 3 — chart scaffolding", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("inlines uPlot JS", () => {
    // The vendor JS exports a global `uPlot` IIFE; we check that some
    // unique uPlot internal token appears in the HTML.
    // uPlot's IIFE starts with !function (or var uPlot=)
    expect(html).toMatch(/(?:var\s+uPlot\s*=|uPlot\.IIFE|function\s+uPlot)/);
  });

  it("inlines uPlot CSS class", () => {
    // uPlot's CSS uses .u-plot, .u-cursor, etc.
    expect(html).toContain(".u-wrap");
  });

  it("has 5 chart panel slots in the DOM", () => {
    expect(html).toContain('id="chart-runners"');
    expect(html).toContain('id="chart-queue"');
    expect(html).toContain('id="chart-cf-bypass"');
    expect(html).toContain('id="chart-latency"');
    expect(html).toContain('id="chart-health"');
  });

  it("has chart row CSS grid", () => {
    expect(html).toContain(".charts {");
    expect(html).toContain("grid-template-columns");
  });

  it("each chart panel has a chart-body div", () => {
    // Counts occurrences of 'class="chart-body"' — should be 5 (one per slot).
    var matches = html.match(/class="chart-body"/g) ?? [];
    expect(matches.length).toBe(5);
  });
});

describe("Phase 3 — 5 priority charts", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("declares all 5 chart renderer functions", () => {
    expect(html).toContain("renderChartRunners");
    expect(html).toContain("renderChartQueue");
    expect(html).toContain("renderChartCfBypass");
    expect(html).toContain("renderChartLatency");
    expect(html).toContain("renderChartHealth");
  });

  it("fetches /metrics/range on each refresh", () => {
    expect(html).toContain("/metrics/range");
  });

  it("uses uPlot for the 4 time-series charts", () => {
    expect(html).toContain("new uPlot");
  });

  it("renders the donut without uPlot (custom SVG)", () => {
    // Donut function uses inline <svg width=... viewBox=...
    expect(html).toMatch(/renderChartCfBypass[\s\S]*?<svg/);
  });

  it("CHARTS_RANGE_MS defaults to 1 hour", () => {
    // 1h = 60 * 60 * 1000 = 3600000
    expect(html).toMatch(/CHARTS_RANGE_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  });
});

describe("Phase 4 — drawer shell", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("has a drawer overlay container in the DOM", () => {
    expect(html).toContain('id="drawer-overlay"');
    expect(html).toContain('id="drawer"');
  });

  it("has all 7 time-range buttons", () => {
    ["Now", "10min", "30min", "1h", "6h", "24h", "7d", "30d"].forEach((label) => {
      expect(html).toContain('data-range="' + label + '"');
    });
  });

  it("has a close button + ESC handler", () => {
    expect(html).toContain('id="drawer-close"');
    expect(html).toMatch(/key === ['"]Escape['"]/);
  });

  it("supports closing via overlay click", () => {
    expect(html).toContain("closeDrawer");
  });

  it("openDrawer function is defined and resets to Now on each open", () => {
    expect(html).toContain("function openDrawer(");
    // grill-me Q6c: drill-down resets to "Now" per open (state NOT persisted)
    expect(html).toMatch(/drawerSelectedRange\s*=\s*['"]Now['"]/);
  });

  it("defines RANGE_MS lookup for the 7 ranges", () => {
    expect(html).toContain('"10min"');
    expect(html).toContain('"30d"');
    expect(html).toContain("RANGE_MS");
  });
});

describe("Phase 4 — signals drill-down", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("Signals panel header has a History button", () => {
    // Heuristic: between the "Active signals" header text and its closing </header>,
    // there is a button with data-drawer="signals".
    expect(html).toMatch(/Active signals[\s\S]*?data-drawer="signals"/);
  });

  it("signalsDrawerRenderer is defined", () => {
    expect(html).toContain("function signalsDrawerRenderer(");
  });

  it("signalsDrawerRenderer fetches /signals/history with from/to from selected range", () => {
    expect(html).toContain("/signals/history?from=");
  });

  it("renderSignalsGantt is defined and uses SVG bars per signal", () => {
    expect(html).toContain("function renderSignalsGantt(");
    expect(html).toMatch(/<rect /);
  });

  it("renders an event table after the Gantt chart", () => {
    // The renderer concatenates the Gantt SVG with a chronological event table.
    expect(html).toMatch(/<th>Time<\/th>[\s\S]*?<th>Event<\/th>/);
  });

  it("openDrawer is invoked with the signals title and signalsDrawerRenderer", () => {
    expect(html).toMatch(/openDrawer\(['"]Signals history['"],\s*signalsDrawerRenderer/);
  });
});
