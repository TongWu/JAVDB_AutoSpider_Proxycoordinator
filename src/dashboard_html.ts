/**
 * Phase 3 — Server-rendered HTML for the operator dashboard.
 *
 * Lifted out of index.ts to keep that file focused on routing. All
 * interactive behaviour lives in the inline <script> tag rendered here.
 *
 * Architecture (full picture lands by end of Phase 3):
 *   - Visibility-aware polling (5s visible / 30s hidden / pause after 30 min hidden)
 *   - Browser-local time formatting with timezone abbreviation
 *   - localStorage-persisted filter + time-range state
 *   - uPlot charts (vendored, see uplot_vendor.ts)
 *
 * See docs/ai/adr/ADR-003 for the data-pipeline design that feeds this UI.
 */

import { UPLOT_MIN_JS, UPLOT_MIN_CSS } from "./uplot_vendor";

export function renderDashboardHtml(_url: URL): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Dashboard · Proxy Coordinator</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>${UPLOT_MIN_CSS}
${commonDashboardStyles()}
  body { padding-top: 56px; }
  .topbar {
    position: fixed; top: 0; left: 0; right: 0; height: 56px; z-index: 10;
    display: flex; align-items: center; padding: 0 24px;
    background: rgba(11, 15, 21, 0.85); backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
  }
  .topbar .brand { display:flex; align-items:center; gap:8px; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
  .topbar .title { font-size: 13px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text); }
  .topbar .sub { font-size: 11px; color: var(--muted); }
  .topbar .spacer { flex: 1; }
  .topbar .meta { display:flex; align-items:center; gap:18px; font-size: 12px; color: var(--muted); }
  .topbar .meta code { color: var(--text); }
  /* User feedback: move the live-pulse dot next to the "live" status
     label instead of the brand title — keeps the brand area static
     and pairs the colour state with the word that explains it. */
  .topbar .state-indicator { display:inline-flex; align-items:center; gap:6px; }
  .topbar .state-indicator .dot { width:8px; height:8px; border-radius:50%; background: var(--muted); transition: background .2s, box-shadow .2s; }
  .topbar .state-indicator.live .dot { background: var(--ok); box-shadow: 0 0 10px var(--ok); animation: pulse 2s infinite; }
  .topbar .state-indicator.err .dot { background: var(--bad); box-shadow: 0 0 10px var(--bad); }
  .topbar a.logout { color: var(--muted); text-decoration: none; font-size: 12px; padding: 5px 10px; border: 1px solid var(--border); border-radius: 6px; transition: color .15s, border-color .15s; }
  .topbar a.logout:hover { color: var(--text); border-color: var(--muted); }
  .topbar button.lang-toggle {
    color: var(--muted); background: transparent; font-size: 12px; padding: 5px 10px;
    border: 1px solid var(--border); border-radius: 6px; cursor: pointer;
    transition: color .15s, border-color .15s; font-family: inherit;
  }
  .topbar button.lang-toggle:hover { color: var(--text); border-color: var(--muted); }
  main { max-width: 1440px; margin: 0 auto; padding: 28px 24px 56px; }

  /* Hero stats row */
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 24px; }
  .stat-card {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px 18px;
  }
  .stat-card .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); margin-bottom: 6px; }
  .stat-card .value { font-size: 32px; font-weight: 600; color: var(--text); letter-spacing: -0.02em; line-height: 1.1; }
  .stat-card .delta { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .stat-card.warn .value { color: var(--warn); }
  .stat-card.bad .value { color: var(--bad); }
  .stat-card.ok .value { color: var(--ok); }

  /* Section grid */
  .grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 20px; }
  @media (max-width: 1000px) { .grid { grid-template-columns: 1fr; } .stats { grid-template-columns: repeat(2, 1fr); } }
  .panel {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
    overflow: hidden; display: flex; flex-direction: column;
  }
  .panel header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--border);
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted);
  }
  .panel header .badge { font-size: 10px; background: var(--input-bg); color: var(--text); padding: 2px 7px; border-radius: 4px; letter-spacing: 0; text-transform: none; }
  .panel .body { padding: 0; }
  .panel.full { grid-column: 1 / -1; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { padding: 9px 16px; text-align: left; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  th { font-weight: 500; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); background: rgba(0,0,0,0.15); }
  td code { background: var(--input-bg); padding: 2px 6px; border-radius: 3px; color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
  td .muted { color: var(--muted); }
  td .pill { display: inline-block; padding: 2px 7px; font-size: 11px; border-radius: 999px; font-weight: 500; }
  td .pill.ok { background: rgba(74, 222, 128, 0.12); color: var(--ok); }
  td .pill.warn { background: rgba(251, 191, 36, 0.12); color: var(--warn); }
  td .pill.bad { background: rgba(248, 113, 113, 0.12); color: var(--bad); }
  td .pill.muted { background: var(--input-bg); color: var(--muted); }

  .score-bar { display: inline-flex; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; }
  .score-bar .track { width: 80px; height: 4px; border-radius: 2px; background: var(--input-bg); overflow: hidden; }
  .score-bar .fill { display: block; height: 100%; background: linear-gradient(90deg, var(--ok), var(--accent)); border-radius: 2px; }

  .empty { padding: 22px 16px; color: var(--muted); font-style: italic; font-size: 12.5px; text-align: center; }
  .hint { padding: 14px 16px; color: var(--muted); font-size: 12px; line-height: 1.5; }
  .hint code { background: var(--input-bg); padding: 1px 5px; border-radius: 3px; color: var(--text); }

  /* Phase-1 ADR-008 — operator mutation buttons. */
  .op-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 11px; font-size: 11.5px; line-height: 1;
    background: var(--input-bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px;
    cursor: pointer; transition: background .12s, border-color .12s;
    font-family: inherit;
  }
  .op-btn:hover:not(:disabled) { background: rgba(56,189,248,0.08); border-color: var(--accent); }
  .op-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .op-btn-danger { color: var(--bad); border-color: rgba(248, 113, 113, 0.40); }
  .op-btn-danger:hover:not(:disabled) { background: rgba(248,113,113,0.10); border-color: var(--bad); }

  .banner {
    margin: 0 0 22px; padding: 12px 16px;
    background: linear-gradient(90deg, rgba(248, 113, 113, 0.10), rgba(248, 113, 113, 0.02));
    border: 1px solid rgba(248, 113, 113, 0.30); border-radius: 8px;
    color: var(--bad); font-size: 12.5px;
  }
  .banner strong { color: var(--text); margin-right: 6px; }
  .banner.warn { background: linear-gradient(90deg, rgba(251, 191, 36, 0.10), rgba(251, 191, 36, 0.02)); border-color: rgba(251, 191, 36, 0.30); color: var(--warn); }

  details { padding: 0 16px; }
  details summary { padding: 12px 0; cursor: pointer; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); list-style: none; user-select: none; }
  details summary::-webkit-details-marker { display: none; }
  details summary::before { content: "▸"; margin-right: 6px; display: inline-block; transition: transform .15s; }
  details[open] summary::before { transform: rotate(90deg); }
  details .config-grid { padding: 0 0 16px; display: grid; grid-template-columns: minmax(220px, auto) 1fr; gap: 4px 16px; font-size: 12.5px; }
  details .config-grid .k { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  details .config-grid .v { color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .panel-history-btn { background: transparent; color: var(--muted); border: 1px solid var(--border); border-radius: 4px;
    padding: 2px 8px; font-size: 10px; cursor: pointer; letter-spacing: normal; text-transform: none; }
  .panel-history-btn:hover { color: var(--text); border-color: var(--muted); }
  .chip-btn { background: var(--input-bg); color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 1px 8px; cursor: pointer; font-size: 10px; }
  .chip-btn:hover { color: var(--text); }
  .chip { display: inline-block; padding: 2px 10px; margin: 2px; font-size: 11px; border-radius: 999px; cursor: pointer; background: var(--input-bg); color: var(--muted); border: 1px solid var(--border); user-select: none; transition: all .12s; }
  .chip.active { background: var(--accent-dim); color: #0a0e14; border-color: var(--accent); }
  .chip .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; }

  .charts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 22px; }
  @media (max-width: 1100px) { .charts { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 700px) { .charts { grid-template-columns: 1fr; } }
  .chart-panel .chart-body { padding: 8px 12px 12px; min-height: 180px; }
  .chart-panel header { font-size: 11px; }

  .drawer-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.55);
    z-index: 100; opacity: 1; transition: opacity .15s;
  }
  .drawer-overlay.hidden { display: none; opacity: 0; }
  .drawer {
    position: absolute; top: 0; right: 0; height: 100vh;
    width: min(640px, 42vw); min-width: 360px;
    background: var(--card-bg); border-left: 1px solid var(--border);
    display: flex; flex-direction: column;
    transform: translateX(0%); transition: transform .18s ease-out;
    box-shadow: -20px 0 60px rgba(0,0,0,0.6);
  }
  .drawer-overlay.hidden .drawer { transform: translateX(100%); }
  .drawer-header { display: flex; align-items: center; justify-content: space-between;
    padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .drawer-title { font-size: 13px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--text); }
  .drawer-close { background: transparent; color: var(--muted); border: 0; font-size: 22px; cursor: pointer; line-height: 1; }
  .drawer-close:hover { color: var(--text); }
  .drawer-range { padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 4px; }
  .range-btn { background: var(--input-bg); color: var(--muted); border: 1px solid var(--border); border-radius: 4px;
    padding: 3px 10px; font-size: 11px; cursor: pointer; }
  .range-btn:hover { color: var(--text); }
  .range-btn.active { background: var(--accent-dim); color: #0a0e14; border-color: var(--accent); }
  .drawer-body { flex: 1; overflow-y: auto; padding: 16px 18px; }
  @media (max-width: 700px) { .drawer { width: 100vw; } }

  /* Phase-3 ADR-008 — mobile/narrow-viewport polish.
     - The drawer used to floor at 360px; clamp it under viewport width.
     - Tables get a horizontal-scroll wrapper at narrow widths so long
       proxy/session rows don't push the layout sideways.
     - Charts shrink with their container via ResizeObserver (see JS). */
  @media (max-width: 480px) {
    .drawer { min-width: min(360px, 95vw); }
    main { padding: 18px 12px 40px; }
    .topbar { padding: 0 12px; }
    .stats { grid-template-columns: 1fr 1fr; gap: 10px; }
    .stat-card .value { font-size: 24px; }
    table { font-size: 11.5px; }
    th, td { padding: 7px 10px; }
    /* Force the wide proxy / session tables into a horizontal scroll
       wrapper. The ".panel .body" selector is the standard container so
       this applies everywhere a table sits inside a panel. */
    .panel .body { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    /* Sticky first column for proxy / session tables — keeps the
       identifier visible while the user scrolls horizontally. */
    table th:first-child, table td:first-child {
      position: sticky; left: 0; background: var(--card-bg); z-index: 1;
    }
  }
</style></head>
<body>
<div class="topbar">
  <div class="brand" id="brand"><span class="title" data-i18n="Proxy Coordinator">Proxy Coordinator</span><span class="sub" data-i18n="/ ops">/ ops</span></div>
  <div class="spacer"></div>
  <div class="meta">
    <span><span data-i18n="last update">last update</span> <code id="ts">—</code></span>
    <span class="state-indicator" id="state-indicator">
      <span class="dot"></span>
      <span id="state" data-i18n="connecting…">connecting…</span>
    </span>
    <button id="lang-toggle" class="lang-toggle" type="button" aria-label="Switch language">中文</button>
    <form method="POST" action="/dashboard/logout" style="margin:0">
      <button type="submit" style="all:unset"><a class="logout" href="/dashboard/logout" onclick="this.closest('form').submit(); return false;" data-i18n="Sign out">Sign out</a></button>
    </form>
  </div>
</div>
<main>
  <div id="alerts-banner"></div>
  <div id="pipeline-pause-banner"></div>
  <div id="banners"></div>
  <div class="stats" id="stats"></div>
  <div class="charts">
    <div class="panel chart-panel" id="chart-runners"><header data-i18n="Active runners trend">Active runners trend</header><div class="chart-body"></div></div>
    <div class="panel chart-panel" id="chart-queue"><header data-i18n="Queue depth">Queue depth</header><div class="chart-body"></div></div>
    <div class="panel chart-panel" id="chart-cf-bypass"><header data-i18n="CF-bypass / banned ratio">CF-bypass / banned ratio</header><div class="chart-body"></div></div>
    <div class="panel chart-panel" id="chart-latency"><header data-i18n="Per-proxy latency (ms)">Per-proxy latency (ms)</header><div class="chart-body"></div></div>
    <div class="panel chart-panel" id="chart-health"><header data-i18n="Per-proxy health score">Per-proxy health score</header><div class="chart-body"></div></div>
  </div>
  <div class="grid">
    <div class="panel">
      <header>
        <span><span data-i18n="Active runners">Active runners</span> <span class="badge" id="runner-count">0</span></span>
        <button class="panel-history-btn" data-drawer="runners" data-i18n="History →">History →</button>
      </header>
      <div class="body" id="runners"></div>
    </div>
    <div class="panel">
      <header>
        <span><span data-i18n="Active signals">Active signals</span> <span class="badge" id="signal-count">0</span></span>
        <button class="panel-history-btn" data-drawer="signals" data-i18n="History →">History →</button>
      </header>
      <div class="body" id="signals"></div>
    </div>
    <div class="panel">
      <header>
        <span><span data-i18n="Login state">Login state</span> <span class="badge" id="login-badge">—</span></span>
        <button class="panel-history-btn" data-drawer="login" data-i18n="History →">History →</button>
      </header>
      <div class="body" id="login-state-body"></div>
    </div>
    <div class="panel full">
      <header>
        <span><span data-i18n="Sessions">Sessions</span> <span class="badge" id="session-count">0</span></span>
        <span style="font-size:10px;color:var(--muted)" data-i18n="runner-reported lifecycle (ADR-008)">runner-reported lifecycle (ADR-008)</span>
      </header>
      <div class="body" id="sessions"></div>
    </div>
    <div class="panel full">
      <header>
        <span data-i18n="Ops controls">Ops controls</span>
        <span style="font-size:10px;color:var(--muted)" data-i18n="Phase-1 ADR-008 · mutation buttons">Phase-1 ADR-008 · mutation buttons</span>
      </header>
      <div class="body" id="ops-controls" style="padding:14px 16px"></div>
    </div>
    <div class="panel">
      <header>
        <span><span data-i18n="Today's Claims">Today's Claims</span> <span class="badge" id="movie-claim-badge">—</span></span>
        <span style="font-size:10px;color:var(--muted)" data-i18n="MovieClaim DO · Phase-3">MovieClaim DO · Phase-3</span>
      </header>
      <div class="body" id="movie-claim-stats" style="padding:14px 16px"></div>
    </div>
    <div class="panel">
      <header>
        <span><span data-i18n="Work queue">Work queue</span> <span class="badge" id="work-queue-badge">—</span></span>
        <span style="font-size:10px;color:var(--muted)" data-i18n="WorkDistributor · Phase-3">WorkDistributor · Phase-3</span>
      </header>
      <div class="body" id="work-stats" style="padding:14px 16px"></div>
    </div>
    <div class="panel full">
      <header>
        <span><span data-i18n="Per-proxy state">Per-proxy state</span> <span class="badge" id="proxy-count">0</span></span>
        <span style="margin-left:12px;font-size:10px;color:var(--muted)">
          <button data-chip-action="all" class="chip-btn" data-i18n="all">all</button>
          <button data-chip-action="none" class="chip-btn" data-i18n="none">none</button>
          <button data-chip-action="invert" class="chip-btn" data-i18n="invert">invert</button>
        </span>
      </header>
      <div class="body">
        <div id="proxy-chips" style="padding:10px 16px;border-bottom:1px solid var(--border)"></div>
        <div id="proxies"></div>
      </div>
    </div>
    <div class="panel full">
      <header>
        <span data-i18n="Config snapshot">Config snapshot</span>
        <button class="panel-history-btn" data-drawer="config" data-i18n="History →">History →</button>
      </header>
      <div class="body" id="config"></div>
    </div>
  </div>
</main>
<script>${UPLOT_MIN_JS}</script>
<div id="drawer-overlay" class="drawer-overlay hidden" aria-hidden="true">
  <aside id="drawer" class="drawer" role="dialog" aria-label="History detail">
    <header class="drawer-header">
      <span id="drawer-title" class="drawer-title">History</span>
      <button id="drawer-close" class="drawer-close" aria-label="Close">×</button>
    </header>
    <div class="drawer-range">
      <button data-range="Now" class="range-btn active">Now</button>
      <button data-range="10min" class="range-btn">10min</button>
      <button data-range="30min" class="range-btn">30min</button>
      <button data-range="1h" class="range-btn">1h</button>
      <button data-range="6h" class="range-btn">6h</button>
      <button data-range="24h" class="range-btn">24h</button>
      <button data-range="7d" class="range-btn">7d</button>
      <button data-range="30d" class="range-btn">30d</button>
    </div>
    <div id="drawer-body" class="drawer-body"></div>
  </aside>
</div>
<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var brand = $("brand");
  var stateIndicator = $("state-indicator");

  // ── i18n: EN <-> ZH dictionary + T(s) lookup helper ─────────────────
  // The dictionary uses English source strings as keys so render
  // functions can keep their natural-reading literals — wrapping a
  // user-visible label in T("...") makes it translatable without
  // hoisting it to a token registry. Missing keys fall back to the
  // English source. Persisted choice lives in localStorage so a tab
  // reload retains the operator's preference.
  var LANG_KEY = "dashboard.lang";
  var LANG = (function(){
    try { return localStorage.getItem(LANG_KEY) === "zh" ? "zh" : "en"; }
    catch(e) { return "en"; }
  })();
  var I18N_ZH = {
    // topbar
    "Proxy Coordinator": "代理协调器",
    "/ ops": "/ 运维",
    "last update": "最近更新",
    "live": "运行中",
    "polling…": "轮询中…",
    "connecting…": "连接中…",
    "error: ": "错误：",
    "Sign out": "退出登录",
    // hero stats
    "Live runners": "活跃 Runner",
    "Active signals": "活跃信号",
    "Proxies tracked": "代理总数",
    "Healthy proxies": "健康代理",
    // chart panel headers
    "Active runners trend": "Runner 数趋势",
    "Queue depth": "队列深度",
    "CF-bypass / banned ratio": "CF-bypass / 封禁占比",
    "Per-proxy latency (ms)": "各代理延迟 (ms)",
    "Per-proxy health score": "各代理健康分",
    // grid panel headers
    "Active runners": "活跃 Runner",
    "Login state": "登录状态",
    "Sessions": "会话",
    "Ops controls": "运维操作",
    "Today's Claims": "今日 Claim",
    "Work queue": "任务队列",
    "Per-proxy state": "各代理状态",
    "Config snapshot": "配置快照",
    "History →": "历史 →",
    "runner-reported lifecycle (ADR-008)": "Runner 上报的生命周期 (ADR-008)",
    "Phase-1 ADR-008 · mutation buttons": "Phase-1 ADR-008 · 可操作按钮",
    "MovieClaim DO · Phase-3": "MovieClaim DO · Phase-3",
    "WorkDistributor · Phase-3": "WorkDistributor · Phase-3",
    // chip filter buttons
    "all": "全部",
    "none": "无",
    "invert": "反选",
    // generic
    "no data": "暂无数据",
    "registry unavailable": "registry 不可用",
    "No live runners": "无活跃 runner",
    "Cohort healthy — no operator signals": "集群健康 —— 无运维信号",
    "config-state DO unavailable": "config-state DO 不可用",
    // session panel
    "ACTIVE": "进行中",
    "RECENT FAILURES": "近期失败",
    "RECENT COMMITTED": "近期成功",
    "active": "进行中",
    "failed (24h)": "失败 (24h)",
    "No runner sessions reported yet. Requires Python client v1.1+ (ADR-008).": "暂无 runner 上报会话。需要 Python 客户端 v1.1+（ADR-008）。",
    "No proxies seen yet — the first runner register (with proxy_pool payload) will populate this list automatically.": "暂无代理记录 —— 首次 runner 注册（含 proxy_pool）会自动填充列表。",
    "All proxies hidden by chip filter. Click 'all' above to show them.": "所有代理被筛选隐藏。点击上方 'all' 显示。",
    // table headers
    "Holder": "Holder",
    "Workflow": "Workflow",
    "Uptime": "运行时长",
    "Last heartbeat": "最近心跳",
    "Pool hash": "池 Hash",
    "Kind": "类型",
    "Payload": "负载",
    "Expires": "过期时间",
    "Proxy": "代理",
    "Status": "状态",
    "Health": "健康分",
    "Latency": "延迟",
    "Wins / Losses": "成功/失败",
    "Wait": "等待",
    "Ops": "操作",
    "Session": "Session",
    "Write mode": "写入模式",
    "Failure reason": "失败原因",
    "When": "时间",
    // login state
    "version": "版本",
    "lease": "lease",
    "last verified": "上次验证",
    "proxy": "代理",
    "lease held": "lease 已持有",
    "cookie ready": "cookie 就绪",
    "no cookie": "无 cookie",
    "Force re-login": "强制重新登录",
    "login_state unavailable. Click History → for past activity.": "login_state 不可用。点击 History → 查看历史。",
    "Cookie value is never displayed. Click History → for attempt audit log.": "Cookie 值不会显示。点击 History → 查看尝试审计日志。",
    // ops controls
    "Pause pipeline · 1h": "暂停流水线 · 1h",
    "Resume now": "立即恢复",
    "Test alert webhook": "测试告警 webhook",
    "No active pause": "未暂停",
    "RUNTIME SIGNALS": "运行时信号",
    "Throttle global ×2": "全局限流 ×2",
    "Pause all runners": "暂停所有 Runner",
    "Resume (clear signals)": "恢复（清除信号）",
    "global throttle active": "全局限流生效",
    "pause_all active": "pause_all 生效",
    "Paused until": "暂停至",
    "until": "至",
    "left": "剩余",
    "Signals affect every runner within one heartbeat (~60s). Use Resume to clear all active signals at once.": "信号会在一次心跳内（约 60 秒）影响所有 runner。点击 Resume 一键清除所有活跃信号。",
    "Aggregated across all sub-shards for today's date (Asia/Singapore).": "跨当日所有 sub-shard 聚合（Asia/Singapore 时区）。",
    // alerts banner
    "SESSION FAILED": "会话失败",
    "BAN SPIKE": "封禁激增",
    "LOGIN COOLDOWN": "登录冷却",
    "TEST": "测试",
    "Ack": "确认",
    "PIPELINE PAUSED": "流水线已暂停",
    // movie claim
    "Active claims (in-flight)": "进行中 Claim",
    "Staged (awaiting commit)": "Staged（待 commit）",
    "Committed (today)": "已 commit（今日）",
    "Failed hrefs": "失败 href",
    "In cooldown": "冷却中",
    "Dead-lettered": "Dead-letter",
    "MovieClaim DO unavailable (binding missing or v3 migration not applied).": "MovieClaim DO 不可用（binding 缺失或 v3 迁移未应用）。",
    // work queue
    "Total queue size": "队列总数",
    "Visible (claimable)": "可领取",
    "Leased (in-flight)": "已领取 (in-flight)",
    "Oldest item age": "最久未消费",
    "WorkDistributor DO unavailable (binding missing or v5 migration not applied).": "WorkDistributor DO 不可用（binding 缺失或 v5 迁移未应用）。",
    "items": "条",
    "empty": "空",
    "banned": "已封禁",
    "live (status)": "正常",
    "cf-bypass": "cf-bypass",
    "error": "错误",
    "Ban": "封禁",
    "Unban": "解封",
    "edit": "编辑",
  };
  function T(s){
    if(LANG === "zh" && Object.prototype.hasOwnProperty.call(I18N_ZH, s)){
      return I18N_ZH[s];
    }
    return s;
  }
  function applyStaticI18n(){
    document.querySelectorAll("[data-i18n]").forEach(function(el){
      var key = el.getAttribute("data-i18n");
      if(!key) return;
      var translated = T(key);
      if(translated !== el.textContent){
        el.textContent = translated;
      }
    });
  }
  function updateLangToggleLabel(){
    var btn = $("lang-toggle");
    if(btn) btn.textContent = LANG === "zh" ? "EN" : "中文";
  }
  function toggleLang(){
    LANG = LANG === "zh" ? "en" : "zh";
    try { localStorage.setItem(LANG_KEY, LANG); } catch(e) {}
    applyStaticI18n();
    updateLangToggleLabel();
    // refresh() is a function declaration further down the IIFE — JS
    // hoisting makes it callable here. Re-running refresh re-runs every
    // render function, all of which interpolate T()-wrapped literals,
    // so the dynamic panels pick up the new language without waiting
    // for the next 5s polling tick.
    try { refresh(); } catch(e) {}
  }

  // ── Phase 3: browser-local time formatting with tz abbreviation ─────
  var _tzFormatter = new Intl.DateTimeFormat([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZoneName: "short",
  });

  function fmtTs(ms){
    if(!ms) return "—";
    // Intl.DateTimeFormat output is like "14:23:45 SGT"
    return _tzFormatter.format(new Date(ms));
  }
  function fmtAge(ms, nowMs){ if(!ms) return "—"; var s = Math.max(0,(nowMs-ms)/1000); if(s<60) return s.toFixed(0)+"s"; if(s<3600) return (s/60).toFixed(1)+"m"; return (s/3600).toFixed(1)+"h"; }
  function fmtDur(ms){ if(ms<=0) return "—"; var s = ms/1000; if(s<60) return s.toFixed(0)+"s"; if(s<3600) return (s/60).toFixed(1)+"m"; return (s/3600).toFixed(1)+"h"; }
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"})[c]; }); }

  // ── Phase 3: chip-filter state ──────────────────────────────────────
  var PROXY_FILTER_KEY = "dashboard.proxyFilter";
  // Stores the set of EXCLUDED proxy IDs. Empty set = show all.
  var proxyFilter = loadProxyFilter();

  function loadProxyFilter() {
    try {
      var raw = localStorage.getItem(PROXY_FILTER_KEY);
      if (!raw) return new Set();
      return new Set(JSON.parse(raw));
    } catch (e) { return new Set(); }
  }
  function saveProxyFilter() {
    try { localStorage.setItem(PROXY_FILTER_KEY, JSON.stringify(Array.from(proxyFilter))); } catch (e) {}
  }
  function colorForProxy(id) {
    // Stable HSL hash so the same proxy always gets the same colour.
    var h = 0;
    for (var i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    return "hsl(" + (Math.abs(h) % 360) + ", 65%, 60%)";
  }
  function renderProxyChips(data) {
    var rows = data.proxies || [];
    var html = "";
    rows.forEach(function(p){
      var col = colorForProxy(p.proxy_id);
      var on = !proxyFilter.has(p.proxy_id);
      html += '<span class="chip ' + (on ? "active" : "") + '" data-proxy-id="' + esc(p.proxy_id) + '">'
        + '<span class="dot" style="background:' + col + '"></span>'
        + esc(p.proxy_id) + '</span>';
    });
    $("proxy-chips").innerHTML = html;
  }
  document.addEventListener("click", function(e){
    // Phase 4: clicking a proxy row opens its drill-down drawer
    var pRow = e.target.closest && e.target.closest("[data-proxy-row]");
    if (pRow) {
      var pid = pRow.getAttribute("data-proxy-row");
      openDrawer("Proxy detail — " + pid, perProxyDrawerRenderer, { proxy_id: pid });
      return;
    }
    // Phase 4: panel "History →" button → open drawer
    var hBtn = e.target.closest && e.target.closest("[data-drawer]");
    if (hBtn) {
      var which = hBtn.getAttribute("data-drawer");
      if (which === "signals") openDrawer("Signals history", signalsDrawerRenderer, {});
      else if (which === "runners") openDrawer("Runners history", runnersDrawerRenderer, {});
      else if (which === "login") openDrawer("Login history", loginDrawerRenderer, {});
      else if (which === "config") openDrawer("Config audit", configDrawerRenderer, {});
      return;
    }
    var chip = e.target.closest && e.target.closest(".chip");
    if (chip) {
      var id = chip.getAttribute("data-proxy-id");
      if (proxyFilter.has(id)) proxyFilter.delete(id); else proxyFilter.add(id);
      saveProxyFilter();
      refresh();
      return;
    }
    var btn = e.target.closest && e.target.closest("[data-chip-action]");
    if (btn) {
      var action = btn.getAttribute("data-chip-action");
      var allIds = Array.from(document.querySelectorAll("#proxy-chips .chip")).map(function(c){ return c.getAttribute("data-proxy-id"); });
      if (action === "all") proxyFilter = new Set();
      else if (action === "none") proxyFilter = new Set(allIds);
      else if (action === "invert") {
        var inv = new Set();
        allIds.forEach(function(id){ if (!proxyFilter.has(id)) inv.add(id); });
        proxyFilter = inv;
      }
      saveProxyFilter();
      refresh();
    }
  });

  function statTile(label, value, cls){
    return '<div class="stat-card '+(cls||"")+'"><div class="label">'+label+'</div><div class="value">'+esc(String(value))+'</div></div>';
  }

  function renderStats(data, nowMs){
    var runners = (data.runners && data.runners.active_runners) || [];
    var signals = (data.signals && data.signals.active_signals) || [];
    var proxies = data.proxies || [];
    var healthyProxies = proxies.filter(function(p){ return !p.banned && !p.error; }).length;
    var signalCls = signals.length === 0 ? "" : (signals.some(function(s){ return s.kind === "pause_all"; }) ? "bad" : "warn");
    var html = "";
    html += statTile(T("Live runners"), runners.length, runners.length > 0 ? "ok" : "");
    html += statTile(T("Active signals"), signals.length, signalCls);
    html += statTile(T("Proxies tracked"), proxies.length, "");
    html += statTile(T("Healthy proxies"), healthyProxies + " / " + proxies.length, healthyProxies === proxies.length && proxies.length > 0 ? "ok" : (healthyProxies === 0 && proxies.length > 0 ? "bad" : ""));
    $("stats").innerHTML = html;
  }

  function renderBanners(data){
    var signals = (data.signals && data.signals.active_signals) || [];
    if(signals.length === 0){ $("banners").innerHTML = ""; return; }
    var nowMs = data.server_time || Date.now();
    var html = "";
    signals.forEach(function(s){
      var cls = s.kind === "pause_all" ? "" : "warn";
      var payload = "";
      if(s.kind === "throttle_global") payload = "global throttle × " + s.factor;
      else if(s.kind === "ban_proxy") payload = "ban proxy " + esc(s.proxy_id || "?");
      else if(s.kind === "pause_all") payload = "PAUSE ALL RUNNERS";
      else payload = esc(s.kind);
      var ttl = fmtDur((s.expires_at_ms || 0) - nowMs);
      html += '<div class="banner '+cls+'"><strong>'+payload+'</strong>· expires in '+ttl;
      if(s.reason) html += ' · <em>'+esc(s.reason)+'</em>';
      html += ' · <code>'+esc(s.id)+'</code></div>';
    });
    $("banners").innerHTML = html;
  }

  function renderRunners(data, nowMs){
    if(!data.runners || !data.runners.active_runners){ $("runners").innerHTML = '<div class="empty">' + T("registry unavailable") + '</div>'; $("runner-count").textContent = "0"; return; }
    var rows = data.runners.active_runners;
    $("runner-count").textContent = String(rows.length);
    if(rows.length === 0){ $("runners").innerHTML = '<div class="empty">' + T("No live runners") + '</div>'; return; }
    var html = '<table><tr><th>' + T("Holder") + '</th><th>' + T("Workflow") + '</th><th>' + T("Uptime") + '</th><th>' + T("Last heartbeat") + '</th><th>' + T("Pool hash") + '</th></tr>';
    rows.forEach(function(r){
      var lastAge = nowMs - r.last_heartbeat;
      var lastCls = lastAge > 120000 ? "warn" : (lastAge > 300000 ? "bad" : "ok");
      var lastAbsTs = fmtTs(r.last_heartbeat);
      var lastRelAge = fmtAge(r.last_heartbeat, nowMs) + " ago";
      var lastPill = '<span class="pill '+lastCls+'" title="' + esc(lastAbsTs) + '">' + esc(lastRelAge) + '</span>';
      var uptimeAbs = fmtTs(r.started_at);
      var uptimeRel = fmtAge(r.started_at, nowMs);
      html += '<tr><td><code>'+esc(r.holder_id)+'</code></td>'
        + '<td class="muted">'+esc(r.workflow_name || "—")+'</td>'
        + '<td class="muted"><span title="' + esc(uptimeAbs) + '">' + esc(uptimeRel) + '</span></td>'
        + '<td>'+lastPill+'</td>'
        + '<td><code>'+esc((r.proxy_pool_hash || "").slice(0,10) || "—")+'</code></td></tr>';
    });
    html += '</table>';
    $("runners").innerHTML = html;
  }

  function renderSignals(data, nowMs){
    if(!data.signals || !data.signals.active_signals){ $("signals").innerHTML = '<div class="empty">' + T("registry unavailable") + '</div>'; $("signal-count").textContent = "0"; return; }
    var rows = data.signals.active_signals;
    $("signal-count").textContent = String(rows.length);
    if(rows.length === 0){ $("signals").innerHTML = '<div class="empty">' + T("Cohort healthy — no operator signals") + '</div>'; return; }
    var html = '<table><tr><th>' + T("Kind") + '</th><th>' + T("Payload") + '</th><th>' + T("Expires") + '</th></tr>';
    rows.forEach(function(s){
      var cls = s.kind === "pause_all" ? "bad" : "warn";
      var payload = "—";
      if(s.kind === "throttle_global") payload = '× '+esc(s.factor);
      else if(s.kind === "ban_proxy") payload = '<code>'+esc(s.proxy_id || "?")+'</code>';
      var expiresAbs = fmtTs(s.expires_at_ms || 0);
      var expiresRel = "in " + fmtDur((s.expires_at_ms || 0) - nowMs);
      html += '<tr><td><span class="pill '+cls+'">'+esc(s.kind)+'</span></td><td>'+payload+'</td><td class="muted"><span title="' + esc(expiresAbs) + '">' + esc(expiresRel) + '</span></td></tr>';
    });
    html += '</table>';
    $("signals").innerHTML = html;
  }

  function renderConfig(data){
    if(!data.config || !data.config.merged){ $("config").innerHTML = '<div class="empty">' + T("config-state DO unavailable") + '</div>'; return; }
    var entries = Object.entries(data.config.merged);
    if(entries.length === 0){
      $("config").innerHTML = '<div class="hint">No config keys returned. Check that <code>CONFIG_STATE_DO</code> is bound.</div>';
      return;
    }
    var overrideCount = entries.filter(function(kv){ return kv[1].source === "override"; }).length;
    var hdr = entries.length + ' key(s) · ' + overrideCount + ' override(s) · version <code style="text-transform:none;letter-spacing:0">' + esc(String(data.config.version||0)) + '</code>';
    var html = '<details open><summary>'+hdr+'</summary><div class="config-grid">';
    entries.sort(function(a, b){ return a[0].localeCompare(b[0]); }).forEach(function(kv){
      var k = kv[0];
      var entry = kv[1];
      var srcPill = entry.source === "override"
        ? '<span class="pill warn" style="margin-left:8px;font-size:9px;vertical-align:1px">override</span>'
        : '';
      // Phase-2 — inline edit pencil; PATCHes the single key via
      // ConfigState's audit format (key/value/reason).
      var editBtn = '<button class="op-btn" data-edit-config="' + esc(k) + '" '
                  + 'style="margin-left:10px;padding:2px 7px;font-size:10px" '
                  + 'title="Edit override (audit log)">edit</button>';
      html += '<div class="k">'+esc(k)+srcPill+editBtn+'</div><div class="v">'+esc(String(entry.value))+'</div>';
    });
    html += '</div></details>';
    $("config").innerHTML = html;
  }

  function renderProxies(data){
    renderProxyChips(data);  // Phase 3 — always render the chip strip from the full pool
    var allRows = data.proxies || [];
    if (allRows.length === 0) {
      $("proxy-count").textContent = "0";
      $("proxies").innerHTML = '<div class="hint">' + T("No proxies seen yet — the first runner register (with proxy_pool payload) will populate this list automatically.") + '</div>';
      return;
    }
    var rows = allRows.filter(function(p){ return !proxyFilter.has(p.proxy_id); });
    $("proxy-count").textContent = rows.length + " / " + allRows.length;
    if (rows.length === 0) {
      $("proxies").innerHTML = '<div class="hint">' + T("All proxies hidden by chip filter. Click 'all' above to show them.") + '</div>';
      return;
    }
    var html = '<table><tr><th>' + T("Proxy") + '</th><th>' + T("Status") + '</th><th>' + T("Health") + '</th><th>' + T("Latency") + '</th><th>' + T("Wins / Losses") + '</th><th>' + T("Wait") + '</th><th>' + T("Ops") + '</th></tr>';
    rows.forEach(function(p){
      if(p.error){
        html += '<tr data-proxy-row="' + esc(p.proxy_id) + '" style="cursor:pointer"><td><code>'+esc(p.proxy_id)+'</code></td><td colspan="6"><span class="pill bad">' + T("error") + ': '+esc(p.error)+'</span></td></tr>';
        return;
      }
      var statusPill;
      if(p.banned) statusPill = '<span class="pill bad">' + T("banned") + '</span>';
      else if(p.requires_cf_bypass) statusPill = '<span class="pill warn">' + T("cf-bypass") + '</span>';
      else statusPill = '<span class="pill ok">' + T("live (status)") + '</span>';
      var h = p.health || {};
      var score = typeof h.score === "number" ? h.score : 0.5;
      var scoreBar = '<span class="score-bar"><span class="track"><span class="fill" style="width:'+(score*100).toFixed(0)+'%"></span></span><span>'+(score*100).toFixed(0)+'</span></span>';
      var latency = typeof h.latency_ema_ms === "number" ? h.latency_ema_ms.toFixed(0)+" ms" : "—";
      var wins = typeof h.success_count === "number" ? h.success_count : 0;
      var losses = typeof h.failure_count === "number" ? h.failure_count : 0;
      var waitMs = p.nextAvailableAt ? Math.max(0, p.nextAvailableAt - Date.now()) : 0;
      // Phase-1 ADR-008 — Ban / Unban buttons (no Python consumer needed)
      var opsHtml = p.banned
        ? '<button class="op-btn" data-unban-proxy="' + esc(p.proxy_id) + '">' + T("Unban") + '</button>'
        : '<button class="op-btn op-btn-danger" data-ban-proxy="' + esc(p.proxy_id) + '">' + T("Ban") + '</button>';
      html += '<tr data-proxy-row="' + esc(p.proxy_id) + '"><td><code>'+esc(p.proxy_id)+'</code></td>'
        + '<td>'+statusPill+'</td>'
        + '<td>'+scoreBar+'</td>'
        + '<td class="muted">'+esc(latency)+'</td>'
        + '<td class="muted">'+wins+' / '+losses+'</td>'
        + '<td class="muted">'+(waitMs > 0 ? waitMs+"ms" : "—")+'</td>'
        + '<td>' + opsHtml + '</td></tr>';
    });
    html += '</table>';
    $("proxies").innerHTML = html;
  }

  function renderLoginState(_data){
    var body = $("login-state-body");
    // Phase-1 ADR-008 — surface non-sensitive fields + Force re-login
    // button. Cookie itself never crosses this surface.
    fetch("/login_state", { credentials: "same-origin" })
      .then(function(r){ return r.status === 200 ? r.json() : null; })
      .then(function(s){
        if(!s){
          body.innerHTML = '<div class="hint">' + T("login_state unavailable. Click History → for past activity.") + '</div>';
          $("login-badge").textContent = "—";
          return;
        }
        var pill = s.has_active_lease
          ? '<span class="pill warn">' + T("lease held") + '</span>'
          : (s.cookie ? '<span class="pill ok">' + T("cookie ready") + '</span>' : '<span class="pill bad">' + T("no cookie") + '</span>');
        $("login-badge").textContent = "v" + (s.version || 0);
        var html = '<div style="padding:14px 16px">'
          + '<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:12.5px">'
          + '<div class="muted">' + T("version") + '</div><div><code>' + esc(String(s.version || 0)) + '</code></div>'
          + '<div class="muted">' + T("lease") + '</div><div>' + pill + '</div>'
          + '<div class="muted">' + T("last verified") + '</div><div>' + (s.last_verified_at ? fmtTs(s.last_verified_at) : '—') + '</div>'
          + '<div class="muted">' + T("proxy") + '</div><div>' + esc(s.proxy_name || '—') + '</div>'
          + '</div>'
          + '<div style="margin-top:14px"><button class="op-btn op-btn-danger" data-op="force-relogin">' + T("Force re-login") + '</button></div>'
          + '<div class="hint" style="padding:8px 0 0">' + T("Cookie value is never displayed. Click History → for attempt audit log.") + '</div>'
          + '</div>';
        body.innerHTML = html;
      });
  }

  // ── Phase-1 ADR-008: alerts banner + sessions panel + ops controls ─────

  function renderAlertsBanner(data){
    var alerts = (data.alerts && data.alerts.alerts) || [];
    var unacked = alerts.filter(function(a){ return !a.ack; });
    var holder = $("alerts-banner");
    if(unacked.length === 0){ holder.innerHTML = ""; return; }
    var html = '';
    unacked.slice(0, 5).forEach(function(a){
      var kindLabel = a.kind === 'session_failed' ? T('SESSION FAILED')
        : a.kind === 'ban_spike' ? T('BAN SPIKE')
        : a.kind === 'login_cooldown' ? T('LOGIN COOLDOWN')
        : a.kind === 'manual_test' ? T('TEST')
        : String(a.kind || '').toUpperCase();
      html += '<div class="banner" style="margin-bottom:10px">'
        + '<strong>[' + esc(kindLabel) + ']</strong> ' + esc(a.summary || '')
        + ' <span class="muted" style="margin-left:6px">' + esc(fmtTs(a.ts)) + '</span>'
        + ' <button class="op-btn" style="float:right;margin-top:-3px" data-ack-alert="' + esc(a.id) + '">' + T('Ack') + '</button>'
        + '</div>';
    });
    if(unacked.length > 5){
      html += '<div class="hint">+ ' + (unacked.length - 5) + ' more unacked alert(s)</div>';
    }
    holder.innerHTML = html;
  }

  function renderPipelinePauseBanner(data){
    var cfg = data.config || {};
    var values = cfg.values || {};
    var pausedUntilStr = values.pipeline_paused_until || "";
    var pausedUntil = parseInt(pausedUntilStr, 10);
    var holder = $("pipeline-pause-banner");
    if(!Number.isFinite(pausedUntil) || pausedUntil <= 0 || pausedUntil <= Date.now()){
      holder.innerHTML = ""; return;
    }
    var reason = values.pipeline_pause_reason || '';
    var until = fmtTs(pausedUntil);
    var rel = fmtDur(pausedUntil - Date.now());
    holder.innerHTML = '<div class="banner" style="margin-bottom:10px"><strong>' + T('PIPELINE PAUSED') + '</strong> · ' + T('until') + ' '
      + esc(until) + ' (' + esc(rel) + ' ' + T('left') + ')'
      + (reason ? ' · <em>' + esc(reason) + '</em>' : '')
      + ' · <button class="op-btn" data-op="resume-pipeline">' + T('Resume now') + '</button>'
      + '</div>';
  }

  function renderSessions(data, nowMs){
    var s = data.sessions || {};
    var active = s.active || [];
    var failed = s.recent_failed || [];
    var committed = s.recent_committed || [];
    $("session-count").textContent = active.length + " " + T("active") + " · " + failed.length + " " + T("failed (24h)");
    if(active.length === 0 && failed.length === 0 && committed.length === 0){
      $("sessions").innerHTML = '<div class="empty">' + T("No runner sessions reported yet. Requires Python client v1.1+ (ADR-008).") + '</div>';
      return;
    }
    function rowsHtml(rows, cls){
      if(rows.length === 0) return '';
      var html = '<table><tr><th>' + T("Session") + '</th><th>' + T("Status") + '</th><th>' + T("Write mode") + '</th><th>' + T("Workflow") + '</th><th>' + T("Failure reason") + '</th><th>' + T("When") + '</th></tr>';
      rows.forEach(function(sess){
        var pillCls = sess.status === 'failed' ? 'bad'
          : sess.status === 'committed' ? 'ok'
          : sess.status === 'in_progress' ? 'warn' : 'muted';
        var when = sess.ended_at > 0 ? fmtTs(sess.ended_at) : fmtTs(sess.updated_at || sess.started_at);
        html += '<tr><td><code>' + esc(sess.session_id) + '</code></td>'
          + '<td><span class="pill ' + pillCls + '">' + esc(sess.status) + '</span></td>'
          + '<td class="muted">' + esc(sess.write_mode || 'unknown') + '</td>'
          + '<td class="muted">' + esc(sess.workflow_name || '—');
        if(sess.workflow_run_id) html += ' · <code>' + esc(sess.workflow_run_id) + '</code>';
        html += '</td>'
          + '<td class="muted" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(sess.failure_reason || '') + '">' + esc(sess.failure_reason || '—') + '</td>'
          + '<td class="muted">' + esc(when) + '</td></tr>';
      });
      html += '</table>';
      return html;
    }
    var html = '';
    if(active.length > 0){
      html += '<div style="padding:8px 16px 0;font-size:11px;color:var(--muted)">' + T("ACTIVE") + '</div>' + rowsHtml(active);
    }
    if(failed.length > 0){
      html += '<div style="padding:14px 16px 0;font-size:11px;color:var(--bad)">' + T("RECENT FAILURES") + '</div>' + rowsHtml(failed);
    }
    if(committed.length > 0){
      html += '<div style="padding:14px 16px 0;font-size:11px;color:var(--muted)">' + T("RECENT COMMITTED") + '</div>' + rowsHtml(committed.slice(0, 10));
    }
    void nowMs;
    $("sessions").innerHTML = html;
  }

  function renderOpsControls(data){
    var values = (data.config && data.config.values) || {};
    var pausedUntilRaw = values.pipeline_paused_until || "";
    var pausedUntil = parseInt(pausedUntilRaw, 10);
    var pausedActive = Number.isFinite(pausedUntil) && pausedUntil > Date.now();
    // Phase-2: detect already-active throttle_global / pause_all signals
    // so we render Resume only when there's something to clear.
    var sigs = (data.signals && data.signals.active_signals) || [];
    var hasGlobalThrottle = sigs.some(function(s){ return s.kind === "throttle_global"; });
    var hasPauseAll = sigs.some(function(s){ return s.kind === "pause_all"; });
    var hasAnySig = sigs.length > 0;
    var html = ''
      + '<div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center">'
      + '<button class="op-btn" data-op="pause-pipeline" data-hours="1">' + T("Pause pipeline · 1h") + '</button>'
      + '<button class="op-btn" data-op="pause-pipeline" data-hours="3">3h</button>'
      + '<button class="op-btn" data-op="pause-pipeline" data-hours="6">6h</button>'
      + '<button class="op-btn" data-op="pause-pipeline" data-hours="24">24h</button>'
      + (pausedActive
          ? '<button class="op-btn op-btn-danger" data-op="resume-pipeline">' + T("Resume now") + '</button>'
          : '')
      + '<span class="muted" style="font-size:11px">'
      + (pausedActive
          ? T("Paused until") + ' ' + esc(fmtTs(pausedUntil)) + ' (' + esc(fmtDur(pausedUntil - Date.now())) + ' ' + T("left") + ')'
          : T("No active pause"))
      + '</span>'
      + '<span style="flex:1"></span>'
      + '<button class="op-btn" data-op="test-alert">' + T("Test alert webhook") + '</button>'
      + '</div>'
      // ── Phase-2: Global throttle / Pause-all / Resume — wired to /signal ──
      + '<div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">'
      + '<span style="font-size:10px;color:var(--muted);margin-right:4px">' + T("RUNTIME SIGNALS") + '</span>'
      + '<button class="op-btn" data-op="throttle-global" data-factor="2">' + T("Throttle global ×2") + '</button>'
      + '<button class="op-btn" data-op="throttle-global" data-factor="4">×4</button>'
      + '<button class="op-btn op-btn-danger" data-op="pause-all">' + T("Pause all runners") + '</button>'
      + (hasAnySig
          ? '<button class="op-btn" data-op="resume-signals">' + T("Resume (clear signals)") + '</button>'
          : '')
      + (hasGlobalThrottle || hasPauseAll
          ? '<span class="pill warn" style="font-size:11px">'
            + (hasGlobalThrottle ? T("global throttle active") : '')
            + (hasGlobalThrottle && hasPauseAll ? ' · ' : '')
            + (hasPauseAll ? T("pause_all active") : '')
            + '</span>'
          : '')
      + '</div>'
      + '<div class="hint" style="padding:8px 0 0;font-size:11px">'
      + T("Signals affect every runner within one heartbeat (~60s). Use Resume to clear all active signals at once.")
      + '</div>';
    $("ops-controls").innerHTML = html;
  }

  // ── Phase-3 ADR-008: MovieClaim + WorkDistributor panels ──────────────

  function statRow(label, value, cls){
    var pillCls = cls ? ' style="color:var(--' + cls + ')"' : '';
    return '<div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0">'
      + '<span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em">' + label + '</span>'
      + '<span' + pillCls + ' style="font-variant-numeric:tabular-nums;font-weight:500">' + value + '</span>'
      + '</div>';
  }

  function renderMovieClaimStats(data){
    var s = data.movie_claim_stats;
    var holder = $("movie-claim-stats");
    var badge = $("movie-claim-badge");
    if(!s){
      holder.innerHTML = '<div class="hint">' + T("MovieClaim DO unavailable (binding missing or v3 migration not applied).") + '</div>';
      badge.textContent = "—";
      return;
    }
    var activeClaims = Number(s.claims_active || 0);
    var staged = Number(s.staged_count || 0);
    var committed = Number(s.completed_committed_count || 0);
    var failures = Number(s.failures_count || 0);
    var cooldown = Number(s.in_cooldown_count || 0);
    var deadLetter = Number(s.dead_lettered_count || 0);
    badge.textContent = committed + " ✓";
    holder.innerHTML = ''
      + statRow(T("Active claims (in-flight)"), activeClaims, activeClaims > 0 ? "warn" : null)
      + statRow(T("Staged (awaiting commit)"), staged)
      + statRow(T("Committed (today)"), committed, committed > 0 ? "ok" : null)
      + statRow(T("Failed hrefs"), failures, failures > 0 ? "warn" : null)
      + statRow(T("In cooldown"), cooldown, cooldown > 0 ? "warn" : null)
      + statRow(T("Dead-lettered"), deadLetter, deadLetter > 0 ? "bad" : null)
      + '<div class="hint" style="padding:8px 0 0;font-size:11px">'
      + T("Aggregated across all sub-shards for today's date (Asia/Singapore).")
      + '</div>';
  }

  function renderWorkStats(data){
    var s = data.work_stats;
    var holder = $("work-stats");
    var badge = $("work-queue-badge");
    if(!s){
      holder.innerHTML = '<div class="hint">' + T("WorkDistributor DO unavailable (binding missing or v5 migration not applied).") + '</div>';
      badge.textContent = "—";
      return;
    }
    var queueSize = Number(s.queue_size || 0);
    var visible = Number(s.visible || 0);
    var leased = Number(s.leased || 0);
    var oldestMs = s.oldest_enqueued_at_ms;
    var oldestAge = (oldestMs && Number.isFinite(oldestMs))
      ? fmtAge(Number(oldestMs), Date.now())
      : "—";
    badge.textContent = queueSize > 0 ? (queueSize + " " + T("items")) : T("empty");
    var leaseCls = leased > 0 ? "warn" : null;
    holder.innerHTML = ''
      + statRow(T("Total queue size"), queueSize, queueSize > 0 ? "warn" : null)
      + statRow(T("Visible (claimable)"), visible)
      + statRow(T("Leased (in-flight)"), leased, leaseCls)
      + statRow(T("Oldest item age"), oldestAge,
                (oldestMs && (Date.now() - Number(oldestMs)) > 1800_000) ? "bad" : null)
      + '<div class="hint" style="padding:8px 0 0;font-size:11px">'
      + 'Spider currently dispatches via MovieClaim DO; this queue is staged for opt-in switchover.'
      + '</div>';
  }

  function postJson(url, body){
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  function patchConfig(values){
    return fetch("/config", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: values }),
    });
  }

  // Delegate clicks on op-btn / data-ack-alert / data-proxy-row buttons.
  document.addEventListener("click", function(ev){
    var t = ev.target;
    if(!(t instanceof Element)) return;
    // Confirm-then-call delegations.
    var op = t.getAttribute("data-op");
    if(op === "force-relogin"){
      if(!confirm("Force invalidate the current login cookie? The next runner will need to re-login.")) return;
      postJson("/login/invalidate_force", {}).then(refresh);
      return;
    }
    if(op === "pause-pipeline"){
      var hours = parseInt(t.getAttribute("data-hours") || "1", 10);
      if(!confirm("Pause new runners for the next " + hours + "h?")) return;
      var until = Date.now() + hours * 3600 * 1000;
      var reason = prompt("Optional reason for ops log:", "") || "";
      patchConfig({
        pipeline_paused_until: String(until),
        pipeline_pause_reason: reason,
      }).then(refresh);
      return;
    }
    if(op === "resume-pipeline"){
      if(!confirm("Resume the pipeline immediately?")) return;
      patchConfig({
        pipeline_paused_until: "",
        pipeline_pause_reason: "",
      }).then(refresh);
      return;
    }
    if(op === "test-alert"){
      postJson("/alerts/test", {}).then(function(r){
        if(r.status >= 200 && r.status < 300){
          alert("Test alert recorded — check webhook destination.");
        } else {
          alert("Test alert failed: HTTP " + r.status);
        }
        refresh();
      });
      return;
    }
    var ackId = t.getAttribute("data-ack-alert");
    if(ackId){
      postJson("/alerts/ack", { id: ackId }).then(refresh);
      return;
    }
    var banPid = t.getAttribute("data-ban-proxy");
    if(banPid){
      var ttlH = prompt("Ban " + banPid + " for how many hours? (default: server-side BAN_TTL_MS)", "");
      if(ttlH === null) return;
      var body = { proxy_id: banPid, reason: "dashboard manual ban" };
      var n = parseInt(ttlH, 10);
      if(Number.isFinite(n) && n > 0) body.ttl_ms = n * 3600 * 1000;
      postJson("/proxies/ban", body).then(refresh);
      return;
    }
    var unbanPid = t.getAttribute("data-unban-proxy");
    if(unbanPid){
      if(!confirm("Lift the ban on " + unbanPid + "?")) return;
      postJson("/proxies/unban", { proxy_id: unbanPid }).then(refresh);
      return;
    }
    // ── Phase-2: signal mutations ────────────────────────────────────────
    if(op === "throttle-global"){
      var factor = parseFloat(t.getAttribute("data-factor") || "2");
      var ttlMinRaw = prompt(
        "Throttle every runner ×" + factor + " for how many minutes?",
        "30"
      );
      if(ttlMinRaw === null) return;
      var ttlMin = parseFloat(ttlMinRaw);
      if(!Number.isFinite(ttlMin) || ttlMin <= 0){
        alert("Invalid TTL");
        return;
      }
      var reason = prompt("Optional reason (ops log):", "") || "";
      postJson("/signal", {
        kind: "throttle_global",
        factor: factor,
        ttl_ms: Math.floor(ttlMin * 60_000),
        reason: reason,
      }).then(function(r){
        if(r.status >= 400) alert("throttle_global failed: HTTP " + r.status);
        refresh();
      });
      return;
    }
    if(op === "pause-all"){
      if(!confirm("Pause EVERY active runner now? They will halt on the next heartbeat (~60s).")) return;
      var ttlMinRaw2 = prompt("Pause for how many minutes?", "15");
      if(ttlMinRaw2 === null) return;
      var ttlMin2 = parseFloat(ttlMinRaw2);
      if(!Number.isFinite(ttlMin2) || ttlMin2 <= 0){
        alert("Invalid TTL"); return;
      }
      var reason2 = prompt("Optional reason (ops log):", "") || "";
      postJson("/signal", {
        kind: "pause_all",
        ttl_ms: Math.floor(ttlMin2 * 60_000),
        reason: reason2,
      }).then(function(r){
        if(r.status >= 400) alert("pause_all failed: HTTP " + r.status);
        refresh();
      });
      return;
    }
    if(op === "resume-signals"){
      if(!confirm("Clear ALL active signals (throttle, pause_all, ban_proxy) right now?")) return;
      postJson("/signal", { kind: "resume" }).then(function(r){
        if(r.status >= 400) alert("resume failed: HTTP " + r.status);
        refresh();
      });
      return;
    }
    // ── Phase-2: inline config edit ──────────────────────────────────────
    var editKey = t.getAttribute("data-edit-config");
    if(editKey){
      var curEntry = (data_last_snapshot && data_last_snapshot.config
                      && data_last_snapshot.config.merged
                      && data_last_snapshot.config.merged[editKey]) || null;
      var curValue = curEntry ? String(curEntry.value) : "";
      var newValue = prompt("New value for " + editKey + " (empty clears override):", curValue);
      if(newValue === null) return;
      var reason3 = prompt("Optional audit reason:", "") || "";
      fetch("/config", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: editKey, value: newValue, reason: reason3 }),
      }).then(function(r){
        if(r.status >= 400){
          r.text().then(function(body){
            alert("PATCH /config failed: HTTP " + r.status + "\\n" + body);
          });
        }
        refresh();
      });
      return;
    }
  });

  function setBrandLive(live){
    // Kept the function name for caller-compat; the actual indicator
    // moved from .brand to #state-indicator so the colour pairs with
    // the "live" / "polling…" / "error: ..." text instead of the
    // brand title. Brand stays neutral.
    if(stateIndicator){
      stateIndicator.classList.toggle("live", !!live);
      stateIndicator.classList.toggle("err", !live);
    }
  }

  // ── Phase 3: charts ─────────────────────────────────────────────────
  var CHARTS_RANGE_MS = 60 * 60 * 1000;  // last 1h on main view
  var charts = {};  // chart-id → uPlot instance for cleanup

  // Phase-3 ADR-008 — chart width tracks its container instead of being
  // hard-coded to 360px. Falls back to 360 when the element is detached
  // (initial render before mount). Height stays fixed at 180 to keep
  // the trend strip recognisable on every breakpoint.
  function chartWidthFor(panelId){
    var body = $(panelId) && $(panelId).querySelector(".chart-body");
    if(!body) return 360;
    var w = body.clientWidth || body.getBoundingClientRect().width || 360;
    return Math.max(160, Math.floor(w - 16));  // -16 for padding fudge
  }

  function chartOptions(seriesDef, panelId){
    return {
      width: chartWidthFor(panelId), height: 180,
      cursor: { drag: { x: false } },
      legend: { show: false },
      scales: { x: { time: true } },
      series: seriesDef,
      padding: [8, 12, 12, 36],
      axes: [
        { stroke: "#6e7681", grid: { stroke: "#1f2730" } },
        { stroke: "#6e7681", grid: { stroke: "#1f2730" } },
      ],
    };
  }

  // Single ResizeObserver instance shared across all charts. Triggers
  // chart.setSize on resize; uPlot is cheap to re-size (no re-render
  // of data, only canvas dimensions update).
  var _chartResizeObserver = null;
  function ensureChartResizeObserver(){
    if(_chartResizeObserver !== null) return _chartResizeObserver;
    if(typeof ResizeObserver === "undefined") return null;
    _chartResizeObserver = new ResizeObserver(function(){
      Object.keys(charts).forEach(function(id){
        var c = charts[id];
        if(!c) return;
        // Map chart key -> panel id. Main charts use the "chart-XXX"
        // pattern; drawer charts use their own DOM nodes and don't
        // appear in the charts dict so they don't need this.
        var panelId = "chart-" + id;
        var w = chartWidthFor(panelId);
        try { c.setSize({ width: w, height: 180 }); } catch(e) {}
      });
    });
    return _chartResizeObserver;
  }

  function attachChartResize(panelId){
    var obs = ensureChartResizeObserver();
    if(!obs) return;
    var body = $(panelId) && $(panelId).querySelector(".chart-body");
    if(body) {
      try { obs.observe(body); } catch(e) {}
    }
  }

  function destroyChart(id){
    if(charts[id]){
      try { charts[id].destroy(); } catch(e) {}
      delete charts[id];
    }
  }

  function timeAxis(snapshots){
    // uPlot expects unix-seconds, not ms.
    return snapshots.map(function(s){ return Math.floor(s.ts/1000); });
  }

  function chartBody(panelId){
    return $(panelId).querySelector(".chart-body");
  }

  function renderChartRunners(snapshots){
    var ts = timeAxis(snapshots);
    var vals = snapshots.map(function(s){ return (s.payload.runners && s.payload.runners.active_runners && s.payload.runners.active_runners.length) || 0; });
    destroyChart("runners");
    var body = chartBody("chart-runners");
    if(ts.length === 0){ body.innerHTML = '<div class="empty">no data</div>'; return; }
    body.innerHTML = "";  // clear before uPlot mounts
    charts["runners"] = new uPlot(
      chartOptions([{}, { label: "active", stroke: "#4ade80", width: 2 }], "chart-runners"),
      [ts, vals],
      body
    );
    attachChartResize("chart-runners");
  }

  function renderChartQueue(snapshots){
    var ts = timeAxis(snapshots);
    var queued = snapshots.map(function(s){ return (s.payload.work && s.payload.work.queued) || 0; });
    var inFlight = snapshots.map(function(s){ return (s.payload.work && s.payload.work.in_flight) || 0; });
    destroyChart("queue");
    var body = chartBody("chart-queue");
    if(ts.length === 0){ body.innerHTML = '<div class="empty">no data</div>'; return; }
    body.innerHTML = "";
    charts["queue"] = new uPlot(
      chartOptions([
        {},
        { label: "queued", stroke: "#38bdf8", width: 2 },
        { label: "in_flight", stroke: "#fbbf24", width: 2 },
      ], "chart-queue"),
      [ts, queued, inFlight],
      body
    );
    attachChartResize("chart-queue");
  }

  function renderChartCfBypass(snapshots){
    var latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
    var proxies = (latest && latest.payload.proxies) || [];
    var banned = proxies.filter(function(p){ return p.banned; }).length;
    var cfBypass = proxies.filter(function(p){ return p.requires_cf_bypass; }).length;
    var healthy = proxies.length - banned - cfBypass;
    var total = proxies.length || 1;

    function arc(start, end, color){
      // SVG donut arc helper. start/end are fractions [0,1].
      var R = 50, r = 30, CX = 70, CY = 70;
      var a0 = start * Math.PI * 2 - Math.PI/2;
      var a1 = end * Math.PI * 2 - Math.PI/2;
      var large = (end - start) > 0.5 ? 1 : 0;
      var x0 = CX + R * Math.cos(a0), y0 = CY + R * Math.sin(a0);
      var x1 = CX + R * Math.cos(a1), y1 = CY + R * Math.sin(a1);
      var xi0 = CX + r * Math.cos(a1), yi0 = CY + r * Math.sin(a1);
      var xi1 = CX + r * Math.cos(a0), yi1 = CY + r * Math.sin(a0);
      return '<path d="M' + x0 + ',' + y0 + ' A' + R + ',' + R + ' 0 ' + large + ',1 ' + x1 + ',' + y1
        + ' L' + xi0 + ',' + yi0 + ' A' + r + ',' + r + ' 0 ' + large + ',0 ' + xi1 + ',' + yi1
        + ' Z" fill="' + color + '" />';
    }

    var body = chartBody("chart-cf-bypass");
    if(proxies.length === 0){ body.innerHTML = '<div class="empty">no data</div>'; return; }

    var f1 = healthy / total;
    var f2 = f1 + cfBypass / total;
    var html = '<svg width="140" height="140" viewBox="0 0 140 140" style="margin:auto;display:block">';
    if(healthy > 0)  html += arc(0,  f1, "#4ade80");
    if(cfBypass > 0) html += arc(f1, f2, "#fbbf24");
    if(banned > 0)   html += arc(f2, 1,  "#f87171");
    html += '<text x="70" y="74" text-anchor="middle" font-size="14" fill="#d4d7e0" font-family="ui-sans-serif">' + proxies.length + '</text>';
    html += '<text x="70" y="92" text-anchor="middle" font-size="9" fill="#6e7681">proxies</text>';
    html += '</svg>'
      + '<div style="text-align:center;font-size:11px;color:var(--muted);margin-top:6px">'
      + '<span style="color:#4ade80">● healthy ' + healthy + '</span> · '
      + '<span style="color:#fbbf24">● cf-bypass ' + cfBypass + '</span> · '
      + '<span style="color:#f87171">● banned ' + banned + '</span>'
      + '</div>';
    body.innerHTML = html;
  }

  function renderChartLatency(snapshots){
    var ts = timeAxis(snapshots);
    var allIds = new Set();
    snapshots.forEach(function(s){ ((s.payload.proxies) || []).forEach(function(p){ allIds.add(p.proxy_id); }); });
    var idList = Array.from(allIds).filter(function(id){ return !proxyFilter.has(id); });
    var series = idList.map(function(id){
      return snapshots.map(function(s){
        var p = ((s.payload.proxies) || []).find(function(x){ return x.proxy_id === id; });
        return p && p.health ? p.health.latency_ema_ms : null;
      });
    });
    destroyChart("latency");
    var body = chartBody("chart-latency");
    if(ts.length === 0 || idList.length === 0){ body.innerHTML = '<div class="empty">no data</div>'; return; }
    body.innerHTML = "";
    var seriesDef = [{}].concat(idList.map(function(id){
      return { label: id, stroke: colorForProxy(id), width: 1.5 };
    }));
    charts["latency"] = new uPlot(
      chartOptions(seriesDef, "chart-latency"),
      [ts].concat(series),
      body
    );
    attachChartResize("chart-latency");
  }

  function renderChartHealth(snapshots){
    var ts = timeAxis(snapshots);
    var allIds = new Set();
    snapshots.forEach(function(s){ ((s.payload.proxies) || []).forEach(function(p){ allIds.add(p.proxy_id); }); });
    var idList = Array.from(allIds).filter(function(id){ return !proxyFilter.has(id); });
    var series = idList.map(function(id){
      return snapshots.map(function(s){
        var p = ((s.payload.proxies) || []).find(function(x){ return x.proxy_id === id; });
        var sc = p && p.health ? p.health.score : null;
        return typeof sc === "number" ? sc * 100 : null;
      });
    });
    destroyChart("health");
    var body = chartBody("chart-health");
    if(ts.length === 0 || idList.length === 0){ body.innerHTML = '<div class="empty">no data</div>'; return; }
    body.innerHTML = "";
    var seriesDef = [{}].concat(idList.map(function(id){
      return { label: id, stroke: colorForProxy(id), width: 1.5 };
    }));
    charts["health"] = new uPlot(
      chartOptions(seriesDef, "chart-health"),
      [ts].concat(series),
      body
    );
    attachChartResize("chart-health");
  }

  // ── Phase 4: drawer state machine ───────────────────────────────────
  var drawerOpen = false;
  var drawerSelectedRange = "Now";
  var drawerRenderer = null;   // function(rangeMs, ctxArgs)
  var drawerCtx = {};          // free-form context (e.g., proxy_id when opened from per-proxy panel)

  var RANGE_MS = {
    "Now": 0,
    "10min": 600000,
    "30min": 1800000,
    "1h": 3600000,
    "6h": 21600000,
    "24h": 86400000,
    "7d": 604800000,
    "30d": 2592000000,
  };

  function openDrawer(title, renderer, ctxArgs){
    drawerOpen = true;
    drawerSelectedRange = "Now";  // grill-me Q6c: drill-down resets per open
    drawerRenderer = renderer;
    drawerCtx = ctxArgs || {};
    $("drawer-title").textContent = title;
    document.querySelectorAll(".range-btn").forEach(function(b){
      b.classList.toggle("active", b.getAttribute("data-range") === "Now");
    });
    $("drawer-overlay").classList.remove("hidden");
    $("drawer-overlay").setAttribute("aria-hidden", "false");
    renderDrawer();
  }

  function closeDrawer(){
    drawerOpen = false;
    $("drawer-overlay").classList.add("hidden");
    $("drawer-overlay").setAttribute("aria-hidden", "true");
    $("drawer-body").innerHTML = "";
    drawerRenderer = null;
  }

  function renderDrawer(){
    if (!drawerRenderer) return;
    var rangeMs = RANGE_MS[drawerSelectedRange];
    drawerRenderer(rangeMs, drawerCtx);
  }

  // Wire drawer events
  $("drawer-close").addEventListener("click", closeDrawer);
  $("drawer-overlay").addEventListener("click", function(e){
    // Click on backdrop (not on the panel itself) closes.
    if (e.target === $("drawer-overlay")) closeDrawer();
  });
  document.addEventListener("keydown", function(e){
    if (e.key === "Escape" && drawerOpen) closeDrawer();
  });
  document.querySelectorAll(".range-btn").forEach(function(b){
    b.addEventListener("click", function(){
      drawerSelectedRange = b.getAttribute("data-range");
      document.querySelectorAll(".range-btn").forEach(function(x){
        x.classList.toggle("active", x === b);
      });
      renderDrawer();
    });
  });

  // ── Phase 4: signals drill-down ─────────────────────────────────────
  function signalsDrawerRenderer(rangeMs, _ctx){
    var body = $("drawer-body");
    body.innerHTML = '<div class="empty">loading…</div>';
    var to = Date.now();
    var from = rangeMs > 0 ? to - rangeMs : to - 60000;  // Now → last 60s for tightness

    fetch("/signals/history?from=" + from + "&to=" + to, { credentials: "same-origin" })
      .then(function(r){ if(r.status !== 200) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(data){
        var rows = data.rows || [];
        if (rows.length === 0){ body.innerHTML = '<div class="empty">No signal events in this window.</div>'; return; }

        // Build Gantt: group by signal_id, find create + matching expire/revoke timestamps.
        var bySignalId = new Map();
        rows.forEach(function(r){
          if (!bySignalId.has(r.signal_id)) bySignalId.set(r.signal_id, []);
          bySignalId.get(r.signal_id).push(r);
        });

        var svg = renderSignalsGantt(bySignalId, from, to);
        var tableRows = rows.map(function(r){
          var payload = "";
          try { payload = r.payload_json ? JSON.stringify(JSON.parse(r.payload_json)) : ""; } catch (e) { payload = r.payload_json || ""; }
          var pillCls = r.event_kind === "create" ? "warn" : "muted";
          return '<tr><td class="muted">' + esc(fmtTs(r.ts)) + '</td>'
            + '<td><span class="pill ' + pillCls + '">' + esc(r.event_kind) + '</span></td>'
            + '<td><code>' + esc(r.signal_kind) + '</code></td>'
            + '<td><code>' + esc(r.signal_id) + '</code></td>'
            + '<td class="muted" style="font-size:11px">' + esc(payload) + '</td></tr>';
        }).join("");

        body.innerHTML = '<div style="margin-bottom:16px">' + svg + '</div>'
          + '<table><tr><th>Time</th><th>Event</th><th>Kind</th><th>Signal ID</th><th>Payload</th></tr>' + tableRows + '</table>';
      })
      .catch(function(err){ body.innerHTML = '<div class="empty">error: ' + esc(err.message) + '</div>'; });
  }

  function renderSignalsGantt(bySignalId, fromMs, toMs){
    // SVG Gantt: horizontal time axis, one row per signal_id, bar from create to expire/revoke.
    var ROW_H = 22, PAD_TOP = 26, PAD_LEFT = 110, RIGHT_PAD = 12;
    var ids = Array.from(bySignalId.keys());
    if (ids.length === 0) return '';
    var width = 600;
    var height = PAD_TOP + ids.length * ROW_H + 20;
    var inner = width - PAD_LEFT - RIGHT_PAD;
    function x(ts){ return PAD_LEFT + (ts - fromMs) / Math.max(1, toMs - fromMs) * inner; }

    var bars = ids.map(function(id, i){
      var evts = bySignalId.get(id).sort(function(a, b){ return a.ts - b.ts; });
      var createEv = evts.find(function(e){ return e.event_kind === "create"; });
      var endEv = evts.find(function(e){ return e.event_kind === "auto_expire" || e.event_kind === "explicit_revoke"; });
      if (!createEv) return '';
      var x0 = x(createEv.ts);
      var x1 = endEv ? x(endEv.ts) : x(toMs);
      var y = PAD_TOP + i * ROW_H + 4;
      var col = createEv.signal_kind === "pause_all" ? "#f87171"
              : createEv.signal_kind === "throttle_global" ? "#fbbf24"
              : createEv.signal_kind === "ban_proxy" ? "#a78bfa"
              : "#38bdf8";
      return '<rect x="' + x0 + '" y="' + y + '" width="' + Math.max(1, x1 - x0) + '" height="14" fill="' + col + '" opacity="0.7" />'
        + '<text x="' + (PAD_LEFT - 6) + '" y="' + (y + 11) + '" text-anchor="end" font-size="10" fill="#6e7681">' + esc(String(id).slice(0, 12)) + '</text>';
    }).join("");

    // Time axis: 4 ticks across.
    var ticks = "";
    for (var t = 0; t <= 4; t++){
      var tickTs = fromMs + (toMs - fromMs) * (t/4);
      var tx = PAD_LEFT + inner * (t/4);
      ticks += '<line x1="' + tx + '" y1="' + (PAD_TOP - 4) + '" x2="' + tx + '" y2="' + (height - 18) + '" stroke="#1f2730" />'
        + '<text x="' + tx + '" y="' + (height - 6) + '" text-anchor="middle" font-size="10" fill="#6e7681">' + esc(fmtTs(tickTs)) + '</text>';
    }
    return '<svg width="' + width + '" height="' + height + '" style="max-width:100%">' + ticks + bars + '</svg>';
  }

  // ── Phase 4: runners drill-down ─────────────────────────────────────
  function runnersDrawerRenderer(rangeMs, _ctx){
    var body = $("drawer-body");
    body.innerHTML = '<div class="empty">loading…</div>';
    var to = Date.now();
    var from = rangeMs > 0 ? to - rangeMs : to - 5 * 60000;  // Now → last 5 min

    fetch("/runners/history?from=" + from + "&to=" + to, { credentials: "same-origin" })
      .then(function(r){ if(r.status !== 200) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(data){
        var rows = data.rows || [];
        if (rows.length === 0){ body.innerHTML = '<div class="empty">No runner events in this window.</div>'; return; }
        var html = '<table><tr><th>Time</th><th>Event</th><th>Holder</th><th>Workflow</th><th>Status</th></tr>';
        rows.forEach(function(r){
          var pill;
          if (r.event_kind === "register") pill = '<span class="pill ok">register</span>';
          else if (r.event_kind === "unregister") pill = '<span class="pill muted">unregister</span>';
          else if (r.event_kind === "crashed") pill = '<span class="pill bad">crashed</span>';
          else pill = '<span class="pill muted">' + esc(r.event_kind) + '</span>';
          html += '<tr><td class="muted">' + esc(fmtTs(r.ts)) + '</td>'
            + '<td>' + pill + '</td>'
            + '<td><code>' + esc(r.holder_id) + '</code></td>'
            + '<td class="muted">' + esc(r.workflow_name || "—") + '</td>'
            + '<td class="muted">' + esc(r.final_status || "—") + '</td></tr>';
        });
        html += '</table>';
        body.innerHTML = html;
      })
      .catch(function(err){ body.innerHTML = '<div class="empty">error: ' + esc(err.message) + '</div>'; });
  }

  // ── Phase 4: login drill-down ───────────────────────────────────────
  function loginDrawerRenderer(rangeMs, _ctx){
    var body = $("drawer-body");
    body.innerHTML = '<div class="empty">loading…</div>';
    var to = Date.now();
    var from = rangeMs > 0 ? to - rangeMs : to - 60 * 60000;  // Now → last 1h

    fetch("/login/history?from=" + from + "&to=" + to, { credentials: "same-origin" })
      .then(function(r){ if(r.status !== 200) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(data){
        var rows = data.rows || [];
        if (rows.length === 0){ body.innerHTML = '<div class="empty">No login events in this window.</div>'; return; }

        // Summary chips: counts by event_kind (and per-outcome for 'attempt')
        var counts = rows.reduce(function(acc, r){
          acc[r.event_kind] = (acc[r.event_kind] || 0) + 1;
          if (r.event_kind === "attempt" && r.outcome){
            acc["_outcome_" + r.outcome] = (acc["_outcome_" + r.outcome] || 0) + 1;
          }
          return acc;
        }, {});

        var summaryParts = [];
        Object.keys(counts).forEach(function(k){
          if (k.indexOf("_outcome_") === 0) return;  // shown separately
          summaryParts.push('<span class="pill muted" style="margin-right:6px">' + esc(k) + ' ' + counts[k] + '</span>');
        });
        if (counts._outcome_success) summaryParts.push('<span class="pill ok" style="margin-right:6px">success ' + counts._outcome_success + '</span>');
        if (counts._outcome_failure) summaryParts.push('<span class="pill bad" style="margin-right:6px">failure ' + counts._outcome_failure + '</span>');
        var summary = '<div style="margin-bottom:12px;font-size:12px;color:var(--muted)">' + summaryParts.join("") + '</div>';

        var html = summary + '<table><tr><th>Time</th><th>Event</th><th>Outcome</th><th>Holder</th><th>Detail</th></tr>';
        rows.forEach(function(r){
          var outcomePill = r.outcome === "success" ? '<span class="pill ok">success</span>'
                          : r.outcome === "failure" ? '<span class="pill bad">failure</span>'
                          : '<span class="pill muted">—</span>';
          html += '<tr><td class="muted">' + esc(fmtTs(r.ts)) + '</td>'
            + '<td><code>' + esc(r.event_kind) + '</code></td>'
            + '<td>' + outcomePill + '</td>'
            + '<td><code>' + esc(r.holder_id || "—") + '</code></td>'
            + '<td class="muted" style="font-size:11px">' + esc(r.detail || "—") + '</td></tr>';
        });
        html += '</table>';
        body.innerHTML = html;
      })
      .catch(function(err){ body.innerHTML = '<div class="empty">error: ' + esc(err.message) + '</div>'; });
  }

  // ── Phase 4: config drill-down ──────────────────────────────────────
  function configDrawerRenderer(rangeMs, _ctx){
    var body = $("drawer-body");
    body.innerHTML = '<div class="empty">loading…</div>';
    var to = Date.now();
    // Config changes are rare; "Now" defaults to all-time (from=0).
    var from = rangeMs > 0 ? to - rangeMs : 0;

    fetch("/config/history?from=" + from + "&to=" + to, { credentials: "same-origin" })
      .then(function(r){ if(r.status !== 200) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(data){
        var rows = data.rows || [];
        if (rows.length === 0){ body.innerHTML = '<div class="empty">No config changes in this window.</div>'; return; }
        var html = '<table><tr><th>Time</th><th>Key</th><th>Old</th><th>New</th><th>Actor</th><th>Reason</th></tr>';
        rows.forEach(function(r){
          var oldText = r.old_value === null || r.old_value === undefined ? "(none)" : String(r.old_value);
          var newText = String(r.new_value);
          var actorPillCls = r.actor_kind === "operator" ? "warn" : "muted";
          html += '<tr><td class="muted">' + esc(fmtTs(r.ts)) + '</td>'
            + '<td><code>' + esc(r.key) + '</code></td>'
            + '<td class="muted"><code>' + esc(oldText) + '</code></td>'
            + '<td><code>' + esc(newText) + '</code></td>'
            + '<td class="muted">' + esc(r.actor || "—") + ' <span class="pill ' + actorPillCls + '" style="font-size:10px">' + esc(r.actor_kind) + '</span></td>'
            + '<td class="muted" style="font-size:11px">' + esc(r.reason || "—") + '</td></tr>';
        });
        html += '</table>';
        body.innerHTML = html;
      })
      .catch(function(err){ body.innerHTML = '<div class="empty">error: ' + esc(err.message) + '</div>'; });
  }

  // ── Phase 4: per-proxy drill-down ───────────────────────────────────
  function perProxyDrawerRenderer(rangeMs, ctx){
    var body = $("drawer-body");
    body.innerHTML = '<div class="empty">loading…</div>';
    var pid = ctx.proxy_id;
    var to = Date.now();
    var from = rangeMs > 0 ? to - rangeMs : to - 60 * 60000;  // Now → last 1h

    fetch("/metrics/range?from=" + from + "&to=" + to, { credentials: "same-origin" })
      .then(function(r){ if(r.status !== 200) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(data){
        var snapshots = data.rows || [];
        if (snapshots.length === 0){ body.innerHTML = '<div class="empty">No metrics in this window.</div>'; return; }

        body.innerHTML = ''
          + '<div style="margin-bottom:18px">'
          +   '<h4 style="font-size:11px;text-transform:uppercase;color:var(--muted);margin:0 0 6px">Success / Failure cumulative</h4>'
          +   '<div id="proxy-chart-sf" style="height:180px"></div>'
          + '</div>'
          + '<div style="margin-bottom:18px">'
          +   '<h4 style="font-size:11px;text-transform:uppercase;color:var(--muted);margin:0 0 6px">Wait time (ms)</h4>'
          +   '<div id="proxy-chart-wait" style="height:180px"></div>'
          + '</div>';

        renderProxyChartSuccessFailure(snapshots, pid, $("proxy-chart-sf"));
        renderProxyChartWait(snapshots, pid, $("proxy-chart-wait"));
      })
      .catch(function(err){ body.innerHTML = '<div class="empty">error: ' + esc(err.message) + '</div>'; });
  }

  function renderProxyChartSuccessFailure(snapshots, pid, container){
    var ts = snapshots.map(function(s){ return Math.floor(s.ts/1000); });
    var succ = snapshots.map(function(s){
      var p = ((s.payload.proxies) || []).find(function(x){ return x.proxy_id === pid; });
      return p && p.health ? p.health.success_count : null;
    });
    var fail = snapshots.map(function(s){
      var p = ((s.payload.proxies) || []).find(function(x){ return x.proxy_id === pid; });
      return p && p.health ? p.health.failure_count : null;
    });
    var width = container.clientWidth || 400;
    new uPlot({
      title: "", width: width, height: 180,
      cursor: { drag: { x: false } },
      legend: { show: true },
      scales: { x: { time: true } },
      series: [
        {},
        { label: "success (cum)", stroke: "#4ade80", width: 2, fill: "rgba(74,222,128,0.15)" },
        { label: "failure (cum)", stroke: "#f87171", width: 2, fill: "rgba(248,113,113,0.15)" },
      ],
      axes: [{ stroke: "#6e7681" }, { stroke: "#6e7681" }],
    }, [ts, succ, fail], container);
  }

  function renderProxyChartWait(snapshots, pid, container){
    var ts = snapshots.map(function(s){ return Math.floor(s.ts/1000); });
    var wait = snapshots.map(function(s){
      var p = ((s.payload.proxies) || []).find(function(x){ return x.proxy_id === pid; });
      if (!p || !p.nextAvailableAt) return 0;
      var w = p.nextAvailableAt - s.ts;
      return w > 0 ? w : 0;
    });
    var width = container.clientWidth || 400;
    new uPlot({
      title: "", width: width, height: 180,
      legend: { show: false },
      scales: { x: { time: true } },
      series: [{}, { label: "wait_ms", stroke: "#fbbf24", width: 2, fill: "rgba(251,191,36,0.15)" }],
      axes: [{ stroke: "#6e7681" }, { stroke: "#6e7681" }],
    }, [ts, wait], container);
  }

  // Phase-2 — last /ops/snapshot payload captured for click delegators.
  // The inline config editor reads merged values from here so the
  // prompt opens with the current value pre-filled.
  var data_last_snapshot = null;

  function refresh(){
    $("state").textContent = T("polling…");
    return Promise.all([
      fetch("/ops/snapshot", { credentials: "same-origin" }).then(function(r){
        if(r.status === 401){ window.location.href = "/"; throw new Error("auth"); }
        if(r.status !== 200) throw new Error("HTTP /ops/snapshot " + r.status);
        return r.json();
      }),
      fetch("/metrics/range?from=" + (Date.now() - CHARTS_RANGE_MS) + "&to=" + Date.now(), { credentials: "same-origin" })
        .then(function(r){ return r.status === 200 ? r.json() : { rows: [] }; })
        .catch(function(){ return { rows: [] }; }),
    ]).then(function(results){
      var data = results[0];
      data_last_snapshot = data;
      var snapshots = (results[1].rows || []);
      var nowMs = data.server_time || Date.now();

      renderStats(data, nowMs);
      renderBanners(data);
      renderAlertsBanner(data);
      renderPipelinePauseBanner(data);
      renderRunners(data, nowMs);
      renderSignals(data, nowMs);
      renderLoginState(data);
      renderConfig(data);
      renderProxies(data);
      renderSessions(data, nowMs);
      renderOpsControls(data);
      renderMovieClaimStats(data);
      renderWorkStats(data);

      renderChartRunners(snapshots);
      renderChartQueue(snapshots);
      renderChartCfBypass(snapshots);
      renderChartLatency(snapshots);
      renderChartHealth(snapshots);

      setBrandLive(true);
      $("state").textContent = T("live");
      // Topbar ts already uses innerHTML with tooltip from Task 4 — preserve.
      var tsAbs = fmtTs(nowMs);
      var tsRel = fmtAge(nowMs, Date.now()) + " ago";
      $("ts").innerHTML = '<span title="' + esc(tsRel) + '">' + esc(tsAbs) + '</span>';
    }).catch(function(err){
      setBrandLive(false);
      $("state").textContent = T("error: ") + err.message;
    });
  }

  // ── Phase 3: visibility-aware polling ───────────────────────────────
  var VISIBLE_MS = 5000;
  var HIDDEN_MS = 30000;
  var PAUSE_AFTER_HIDDEN_MS = 1800000;  // 30 min

  var pollTimer = null;
  var hiddenSinceMs = 0;
  var paused = false;

  function currentInterval() {
    if (document.visibilityState === "visible") return VISIBLE_MS;
    return HIDDEN_MS;
  }

  function scheduleNext() {
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
    if (paused) { return; }
    pollTimer = setTimeout(tick, currentInterval());
  }

  function tick() {
    pollTimer = null;
    // If hidden too long, pause entirely until user returns.
    if (document.visibilityState === "hidden" && hiddenSinceMs > 0) {
      var hiddenFor = Date.now() - hiddenSinceMs;
      if (hiddenFor >= PAUSE_AFTER_HIDDEN_MS) {
        paused = true;
        $("state").textContent = "paused (tab hidden)";
        return;
      }
    }
    refresh().finally(scheduleNext);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      hiddenSinceMs = 0;
      paused = false;
      refresh().finally(scheduleNext); // immediate refresh on return
    } else {
      hiddenSinceMs = Date.now();
      scheduleNext(); // re-arm at 30s cadence
    }
  });

  // ── i18n: wire toggle button + apply current language on first paint
  applyStaticI18n();
  updateLangToggleLabel();
  var langBtn = $("lang-toggle");
  if(langBtn) langBtn.addEventListener("click", toggleLang);

  // Initial fetch + start loop.
  refresh().finally(scheduleNext);
})();
</script>
</body></html>`;
}

/** CSS shared between login form + dashboard SPA. Single source of
 *  truth for the color palette + base typography. */
export function commonDashboardStyles(): string {
  return `
  :root {
    --bg: #0a0e14;
    --card-bg: #131820;
    --input-bg: #1c2230;
    --border: #1f2730;
    --text: #d4d7e0;
    --muted: #6e7681;
    --accent: #38bdf8;
    --accent-dim: #0ea5e9;
    --ok: #4ade80;
    --warn: #fbbf24;
    --bad: #f87171;
  }
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Inter", sans-serif;
    margin: 0; background: var(--bg); color: var(--text);
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  }
  a { color: var(--accent); text-decoration: none; }
  `;
}

/** Server-side HTML escape used in the login form's error message slot.
 *  The dashboard's client-side ``esc()`` covers the live-poll path. */
export function escapeHtmlForServer(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
