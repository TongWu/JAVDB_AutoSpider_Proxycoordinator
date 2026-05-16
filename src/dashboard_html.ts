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

export function renderDashboardHtml(_url: URL): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Dashboard · Proxy Coordinator</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>${commonDashboardStyles()}
  body { padding-top: 56px; }
  .topbar {
    position: fixed; top: 0; left: 0; right: 0; height: 56px; z-index: 10;
    display: flex; align-items: center; padding: 0 24px;
    background: rgba(11, 15, 21, 0.85); backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
  }
  .topbar .brand { display:flex; align-items:center; gap:10px; }
  .topbar .brand .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); transition: background .2s, box-shadow .2s; }
  .topbar .brand.live .dot { background: var(--ok); box-shadow: 0 0 10px var(--ok); animation: pulse 2s infinite; }
  .topbar .brand.err .dot { background: var(--bad); box-shadow: 0 0 10px var(--bad); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
  .topbar .title { font-size: 13px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text); }
  .topbar .sub { font-size: 11px; color: var(--muted); }
  .topbar .spacer { flex: 1; }
  .topbar .meta { display:flex; align-items:center; gap:18px; font-size: 12px; color: var(--muted); }
  .topbar .meta code { color: var(--text); }
  .topbar a.logout { color: var(--muted); text-decoration: none; font-size: 12px; padding: 5px 10px; border: 1px solid var(--border); border-radius: 6px; transition: color .15s, border-color .15s; }
  .topbar a.logout:hover { color: var(--text); border-color: var(--muted); }
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
  .chip-btn { background: var(--input-bg); color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 1px 8px; cursor: pointer; font-size: 10px; }
  .chip-btn:hover { color: var(--text); }
  .chip { display: inline-block; padding: 2px 10px; margin: 2px; font-size: 11px; border-radius: 999px; cursor: pointer; background: var(--input-bg); color: var(--muted); border: 1px solid var(--border); user-select: none; transition: all .12s; }
  .chip.active { background: var(--accent-dim); color: #0a0e14; border-color: var(--accent); }
  .chip .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; }
</style></head>
<body>
<div class="topbar">
  <div class="brand" id="brand"><span class="dot"></span><span class="title">Proxy Coordinator</span><span class="sub">/ ops</span></div>
  <div class="spacer"></div>
  <div class="meta">
    <span>last update <code id="ts">—</code></span>
    <span id="state">connecting…</span>
    <form method="POST" action="/dashboard/logout" style="margin:0">
      <button type="submit" style="all:unset"><a class="logout" href="/dashboard/logout" onclick="this.closest('form').submit(); return false;">Sign out</a></button>
    </form>
  </div>
</div>
<main>
  <div id="banners"></div>
  <div class="stats" id="stats"></div>
  <div class="grid">
    <div class="panel">
      <header>Active runners <span class="badge" id="runner-count">0</span></header>
      <div class="body" id="runners"></div>
    </div>
    <div class="panel">
      <header>Active signals <span class="badge" id="signal-count">0</span></header>
      <div class="body" id="signals"></div>
    </div>
    <div class="panel full">
      <header>
        Per-proxy state <span class="badge" id="proxy-count">0</span>
        <span style="margin-left:12px;font-size:10px;color:var(--muted)">
          <button data-chip-action="all" class="chip-btn">all</button>
          <button data-chip-action="none" class="chip-btn">none</button>
          <button data-chip-action="invert" class="chip-btn">invert</button>
        </span>
      </header>
      <div class="body">
        <div id="proxy-chips" style="padding:10px 16px;border-bottom:1px solid var(--border)"></div>
        <div id="proxies"></div>
      </div>
    </div>
    <div class="panel full">
      <header>Config snapshot</header>
      <div class="body" id="config"></div>
    </div>
  </div>
</main>
<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var brand = $("brand");

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
    html += statTile("Live runners", runners.length, runners.length > 0 ? "ok" : "");
    html += statTile("Active signals", signals.length, signalCls);
    html += statTile("Proxies tracked", proxies.length, "");
    html += statTile("Healthy proxies", healthyProxies + " / " + proxies.length, healthyProxies === proxies.length && proxies.length > 0 ? "ok" : (healthyProxies === 0 && proxies.length > 0 ? "bad" : ""));
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
    if(!data.runners || !data.runners.active_runners){ $("runners").innerHTML = '<div class="empty">registry unavailable</div>'; $("runner-count").textContent = "0"; return; }
    var rows = data.runners.active_runners;
    $("runner-count").textContent = String(rows.length);
    if(rows.length === 0){ $("runners").innerHTML = '<div class="empty">No live runners</div>'; return; }
    var html = '<table><tr><th>Holder</th><th>Workflow</th><th>Uptime</th><th>Last heartbeat</th><th>Pool hash</th></tr>';
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
    if(!data.signals || !data.signals.active_signals){ $("signals").innerHTML = '<div class="empty">registry unavailable</div>'; $("signal-count").textContent = "0"; return; }
    var rows = data.signals.active_signals;
    $("signal-count").textContent = String(rows.length);
    if(rows.length === 0){ $("signals").innerHTML = '<div class="empty">Cohort healthy — no operator signals</div>'; return; }
    var html = '<table><tr><th>Kind</th><th>Payload</th><th>Expires</th></tr>';
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
    if(!data.config || !data.config.merged){ $("config").innerHTML = '<div class="empty">config-state DO unavailable</div>'; return; }
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
      html += '<div class="k">'+esc(k)+srcPill+'</div><div class="v">'+esc(String(entry.value))+'</div>';
    });
    html += '</div></details>';
    $("config").innerHTML = html;
  }

  function renderProxies(data){
    renderProxyChips(data);  // Phase 3 — always render the chip strip from the full pool
    var allRows = data.proxies || [];
    if (allRows.length === 0) {
      $("proxy-count").textContent = "0";
      $("proxies").innerHTML = '<div class="hint">No proxies seen yet — the first runner register (with proxy_pool payload) will populate this list automatically.</div>';
      return;
    }
    var rows = allRows.filter(function(p){ return !proxyFilter.has(p.proxy_id); });
    $("proxy-count").textContent = rows.length + " / " + allRows.length;
    if (rows.length === 0) {
      $("proxies").innerHTML = '<div class="hint">All proxies hidden by chip filter. Click <strong>all</strong> above to show them.</div>';
      return;
    }
    var html = '<table><tr><th>Proxy</th><th>Status</th><th>Health</th><th>Latency</th><th>Wins / Losses</th><th>Wait</th></tr>';
    rows.forEach(function(p){
      if(p.error){
        html += '<tr><td><code>'+esc(p.proxy_id)+'</code></td><td colspan="5"><span class="pill bad">error: '+esc(p.error)+'</span></td></tr>';
        return;
      }
      var statusPill;
      if(p.banned) statusPill = '<span class="pill bad">banned</span>';
      else if(p.requires_cf_bypass) statusPill = '<span class="pill warn">cf-bypass</span>';
      else statusPill = '<span class="pill ok">live</span>';
      var h = p.health || {};
      var score = typeof h.score === "number" ? h.score : 0.5;
      var scoreBar = '<span class="score-bar"><span class="track"><span class="fill" style="width:'+(score*100).toFixed(0)+'%"></span></span><span>'+(score*100).toFixed(0)+'</span></span>';
      var latency = typeof h.latency_ema_ms === "number" ? h.latency_ema_ms.toFixed(0)+" ms" : "—";
      var wins = typeof h.success_count === "number" ? h.success_count : 0;
      var losses = typeof h.failure_count === "number" ? h.failure_count : 0;
      var waitMs = p.nextAvailableAt ? Math.max(0, p.nextAvailableAt - Date.now()) : 0;
      html += '<tr><td><code>'+esc(p.proxy_id)+'</code></td>'
        + '<td>'+statusPill+'</td>'
        + '<td>'+scoreBar+'</td>'
        + '<td class="muted">'+esc(latency)+'</td>'
        + '<td class="muted">'+wins+' / '+losses+'</td>'
        + '<td class="muted">'+(waitMs > 0 ? waitMs+"ms" : "—")+'</td></tr>';
    });
    html += '</table>';
    $("proxies").innerHTML = html;
  }

  function setBrandLive(live){
    brand.classList.toggle("live", !!live);
    brand.classList.toggle("err", !live);
  }

  function refresh(){
    $("state").textContent = "polling…";
    // Phase 2/ADR-004: /ops/snapshot auto-discovers proxies from
    // proxies_seen when no proxy_ids is given. We no longer pass
    // PROXY_IDS — the Worker handles the full pool.
    return fetch("/ops/snapshot", { credentials: "same-origin" }).then(function(r){
      if(r.status === 401){ window.location.href = "/"; throw new Error("auth"); }
      if(r.status !== 200) throw new Error("HTTP "+r.status);
      return r.json();
    }).then(function(data){
      var nowMs = data.server_time || Date.now();
      renderStats(data, nowMs);
      renderBanners(data);
      renderRunners(data, nowMs);
      renderSignals(data, nowMs);
      renderConfig(data);
      renderProxies(data);
      setBrandLive(true);
      $("state").textContent = "live";
      var tsAbs = fmtTs(nowMs);
      var tsRel = fmtAge(nowMs, Date.now()) + " ago";
      $("ts").innerHTML = '<span title="' + esc(tsRel) + '">' + esc(tsAbs) + '</span>';
    }).catch(function(err){
      setBrandLive(false);
      $("state").textContent = "error: " + err.message;
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
