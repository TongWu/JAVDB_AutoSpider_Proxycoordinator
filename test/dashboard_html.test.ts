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

describe("Phase 4 — runners drill-down", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("Active runners panel header has a History button", () => {
    expect(html).toMatch(/Active runners[\s\S]*?data-drawer="runners"/);
  });

  it("runnersDrawerRenderer queries /runners/history", () => {
    expect(html).toContain("function runnersDrawerRenderer(");
    expect(html).toContain("/runners/history?from=");
  });

  it("renders pill mapping for register/unregister/crashed event kinds", () => {
    // The renderer maps event_kind → pill class; check that all three labels appear.
    expect(html).toContain('"register"');
    expect(html).toContain('"unregister"');
    expect(html).toContain('"crashed"');
  });

  it("click handler routes the runners button to openDrawer", () => {
    expect(html).toMatch(/openDrawer\(['"]Runners history['"],\s*runnersDrawerRenderer/);
  });
});

describe("Phase 4 — login drill-down", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("has a Login state panel with History button", () => {
    expect(html).toMatch(/Login state[\s\S]*?data-drawer="login"/);
  });

  it("loginDrawerRenderer queries /login/history", () => {
    expect(html).toContain("function loginDrawerRenderer(");
    expect(html).toContain("/login/history?from=");
  });

  it("renderLoginState placeholder is defined and called on refresh", () => {
    expect(html).toContain("function renderLoginState(");
    expect(html).toContain("renderLoginState(data");
  });

  it("login drawer summary chips render counts by event_kind", () => {
    expect(html).toContain("event_kind");  // summary loop
  });

  it("click handler routes the login button to openDrawer", () => {
    expect(html).toMatch(/openDrawer\(['"]Login history['"],\s*loginDrawerRenderer/);
  });
});

describe("Phase 4 — config drill-down", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("Config snapshot panel has History button", () => {
    expect(html).toMatch(/Config snapshot[\s\S]*?data-drawer="config"/);
  });

  it("configDrawerRenderer queries /config/history", () => {
    expect(html).toContain("function configDrawerRenderer(");
    expect(html).toContain("/config/history?from=");
  });

  it("renders old_value / new_value columns", () => {
    expect(html).toMatch(/<th>Old<\/th>[\s\S]*?<th>New<\/th>/);
  });

  it("renders actor_kind pill (operator vs system)", () => {
    expect(html).toContain("actor_kind");
  });

  it("click handler routes the config button to openDrawer", () => {
    expect(html).toMatch(/openDrawer\(['"]Config audit['"],\s*configDrawerRenderer/);
  });
});

describe("Phase 4 — per-proxy drill-down", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("perProxyDrawerRenderer is defined and queries /metrics/range", () => {
    expect(html).toContain("function perProxyDrawerRenderer(");
    expect(html).toContain("/metrics/range?from=");
  });

  it("per-proxy table rows have data-proxy-row attribute (for click-to-open)", () => {
    expect(html).toContain('data-proxy-row');
  });

  it("declares renderProxyChartSuccessFailure and renderProxyChartWait", () => {
    expect(html).toContain("function renderProxyChartSuccessFailure(");
    expect(html).toContain("function renderProxyChartWait(");
  });

  it("click handler routes per-proxy rows to openDrawer with proxy_id context", () => {
    expect(html).toMatch(/openDrawer\([^)]*?perProxyDrawerRenderer[^)]*?proxy_id/);
  });

  it("drawer renders two chart slots (success/failure + wait)", () => {
    expect(html).toContain("proxy-chart-sf");
    expect(html).toContain("proxy-chart-wait");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase-2 ADR-008 — signal mutation buttons + inline config editor.
// These checks pin down the strings that the click delegator dispatches
// on, so a refactor that renames `data-op="throttle-global"` (etc.)
// breaks the test rather than silently breaking the dashboard.
// ─────────────────────────────────────────────────────────────────────────

describe("Phase-2 — runtime signal mutation UI", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("renders Throttle Global x2 button with data-op + factor attributes", () => {
    expect(html).toContain('data-op="throttle-global"');
    expect(html).toContain('data-factor="2"');
    expect(html).toContain("Throttle global");
  });

  it("renders Throttle Global x4 button", () => {
    expect(html).toContain('data-factor="4"');
  });

  it("renders Pause all runners button", () => {
    expect(html).toContain('data-op="pause-all"');
    expect(html).toContain("Pause all runners");
  });

  it("renders Resume (clear signals) button conditional on hasAnySig", () => {
    expect(html).toContain('data-op="resume-signals"');
    expect(html).toContain("Resume (clear signals)");
  });

  it("dispatches throttle_global signal via POST /signal", () => {
    // Click handler body should construct the right body for the throttle button.
    expect(html).toContain('kind: "throttle_global"');
    expect(html).toMatch(/postJson\(\s*"\/signal"/);
  });

  it("dispatches pause_all signal via POST /signal", () => {
    expect(html).toContain('kind: "pause_all"');
  });

  it("dispatches resume signal via POST /signal", () => {
    expect(html).toContain('kind: "resume"');
  });

  it("removes the old Phase-1 disabled placeholder text", () => {
    // Make sure the disabled buttons that were placeholder in Phase 1
    // have been replaced. We assert the absence of the placeholder
    // tooltip so renaming the buttons doesn't silently re-introduce
    // a disabled state.
    expect(html).not.toContain('title="Enabled in Phase 2 (Python consumer)"');
    expect(html).not.toContain("Edit config inline");
  });
});

describe("Phase-2 — inline config editor", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("renderConfig emits an edit button per key with data-edit-config", () => {
    expect(html).toContain('data-edit-config="');
  });

  it("edit handler PATCHes /config using single-key audit format", () => {
    // The body posted via fetch("/config", { method: "PATCH" }, ...) must
    // be a single-key shape so each PATCH leaves one audit row, not many.
    expect(html).toMatch(/method:\s*"PATCH"/);
    expect(html).toMatch(/key:\s*editKey/);
    expect(html).toMatch(/value:\s*newValue/);
    expect(html).toMatch(/reason:\s*reason3/);
  });

  it("prompts with the current value pre-filled from data_last_snapshot", () => {
    expect(html).toContain("data_last_snapshot");
    expect(html).toContain("config.merged");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase-3 ADR-008 — MovieClaim / WorkDistributor panels + responsive CSS.
// ─────────────────────────────────────────────────────────────────────────

describe("Phase-3 — MovieClaim + WorkDistributor panels", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("renders the Today's Claims panel with badge slot", () => {
    expect(html).toContain('id="movie-claim-stats"');
    expect(html).toContain('id="movie-claim-badge"');
    expect(html).toContain("Today's Claims");
  });

  it("renders the Work queue panel with badge slot", () => {
    expect(html).toContain('id="work-stats"');
    expect(html).toContain('id="work-queue-badge"');
    expect(html).toContain("Work queue");
  });

  it("renderMovieClaimStats reads claims_active + staged + committed fields", () => {
    expect(html).toContain("movie_claim_stats");
    expect(html).toContain("claims_active");
    expect(html).toContain("staged_count");
    expect(html).toContain("completed_committed_count");
    expect(html).toContain("dead_lettered_count");
  });

  it("renderWorkStats reads queue_size + visible + leased fields", () => {
    expect(html).toContain("work_stats");
    expect(html).toContain("queue_size");
    expect(html).toContain("oldest_enqueued_at_ms");
  });

  it("renderers are invoked from refresh()", () => {
    expect(html).toContain("renderMovieClaimStats(data)");
    expect(html).toContain("renderWorkStats(data)");
  });
});

describe("Phase-3 — responsive CSS + chart sizing", () => {
  const html = renderDashboardHtml(new URL("https://dash.test/dashboard"));

  it("includes a max-width: 480px breakpoint", () => {
    expect(html).toContain("max-width: 480px");
  });

  it("clamps drawer width under viewport on narrow screens", () => {
    expect(html).toContain("min(360px, 95vw)");
  });

  it("makes panel bodies horizontally scrollable in mobile breakpoint", () => {
    expect(html).toContain("overflow-x: auto");
  });

  it("makes the first table column sticky for horizontal scroll", () => {
    expect(html).toContain("position: sticky");
  });

  it("declares the ResizeObserver-backed chart resize plumbing", () => {
    expect(html).toContain("ResizeObserver");
    expect(html).toContain("ensureChartResizeObserver");
    expect(html).toContain("attachChartResize");
  });

  it("chartOptions now derives width from container instead of hard-coding 360", () => {
    expect(html).toContain("chartWidthFor(panelId)");
    // The old hard-coded width: 360 in chartOptions is gone.
    expect(html).not.toMatch(/chartOptions\s*\(\s*[^)]*\)\s*{\s*return\s*{\s*width:\s*360/);
  });
});
