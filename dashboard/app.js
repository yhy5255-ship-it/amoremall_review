"use strict";
/*
  Amoremall weekly ads dashboard.

  Data pipeline (see scripts/export_agg.py and the "How this works" panel
  in index.html for the full explanation):
    Google Sheet (service account, read-only)
      -> scripts/export_agg.py aggregates raw rows into two DAY-level shapes:
           groups       : date x channel x goal x media x brand x promo x status
           promoGroups  : date x goal x promoFull(AE) x brand(AF) x promo(AG) x material(AW)
      -> data.json (gitignored - contains real spend/revenue numbers), one entry per
         monthly tab, each holding its own day-level groups/promoGroups.
      -> this file lets the user pick any number of tabs (merged into one pool) and
         any freeform A/B date range within that pool's data - not tied to calendar
         weeks or a single month - then re-aggregates on top of the day-level rows
         into the same per-campaign shape export_agg.py used to produce for a single
         week (see aggregateGroupsByDateRange), so every downstream computation
         works unchanged regardless of how the range was chosen.
      -> once groupsA/groupsB exist, this file computes all comparison numbers in the
         browser, then asks /api/comment (a Vercel serverless function) to turn those
         numbers + a user-written note into an analyst-style comment. The Gemini API
         key never reaches the browser - see api/comment.js.

  The UI is organized by BL 목표(goal) - 매출/신규가입/앱설치/트래픽 - each its own
  section, rather than by channel. The KPF block (매출_KPF 상세성과) inside the
  매출 section is fully deterministic - computed and rendered here, never sent
  through the AI - because every number in it is just a sum over a handful of
  rows and there's nothing for an LLM to add.
*/

(function () {
  // ---------- formatting helpers ----------
  const fmtWonAbbrev = (n) => {
    const sign = n < 0 ? "-" : ""; n = Math.abs(n);
    if (n >= 1e8) return sign + (n / 1e8).toFixed(1) + "억원";
    if (n >= 1e7) return sign + (n / 1e7).toFixed(1) + "천만원";
    if (n >= 1e4) return sign + Math.round(n / 1e4) + "만원";
    return sign + Math.round(n).toLocaleString() + "원";
  };
  const fmtWon = (n) => Math.round(n).toLocaleString() + "원";
  const fmtPct = (n) => Math.round(n) + "%";               // ROAS etc. - integer, no decimals
  const fmtPct2 = (n) => n.toFixed(2) + "%";                 // CTR/CVR-style rates - 2 decimals
  const fmtPP = (n) => (n > 0 ? "+" : "") + Math.round(n) + "%p";
  const fmtCount = (n) => Math.round(n).toLocaleString() + "건";
  const fmtNum = (n) => Math.round(n).toLocaleString();
  const fmtDate = (d) => { if (!d || d === "상시") return d || ""; const p = d.split("-"); return `${+p[1]}/${+p[2]}`; };
  const roas = (gmv, spend) => spend > 0 ? gmv / spend * 100 : 0;
  const cpi_ = (spend, install) => install > 0 ? spend / install : 0;
  const ctr_ = (click, impr) => impr > 0 ? click / impr * 100 : 0;
  const cpc_ = (spend, click) => click > 0 ? spend / click : 0;
  const shareOf = (value, total) => total > 0 ? (value / total * 100) : 0;
  const sum = (arr, field) => arr.reduce((a, g) => a + (g[field] || 0), 0);
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function deltaSpan(curr, prev, unit) {
    const d = curr - prev;
    const cls = d > 0.05 ? "up" : d < -0.05 ? "down" : "flat";
    const arrow = d > 0.05 ? "▲" : d < -0.05 ? "▼" : "－";
    return `<span class="delta ${cls}">${arrow} ${unit === "pp" ? fmtPP(d) : unit === "won" ? (d >= 0 ? "+" : "") + fmtWonAbbrev(d) : (d >= 0 ? "+" : "") + fmtNum(d)}</span>`;
  }

  // ---------- grouping helpers ----------
  // Keyed by brand+promo (not promo alone) - different brands sometimes reuse the
  // same 기획전명 (e.g. "2601상시" exists under 헤라, 설화수, 한율, ... independently),
  // so grouping by promo alone would silently merge unrelated campaigns.
  function groupByPromo(groups) {
    const m = new Map();
    for (const g of groups) {
      const key = (g.brand || "") + "||" + (g.promo || "(미지정)");
      if (!m.has(key)) m.set(key, {
        promo: g.promo || "(미지정)", brand: g.brand, status: g.status, promoStart: g.promoStart, promoEnd: g.promoEnd,
        spend: 0, gmv: 0, install: 0, firstPurchase: 0, firstPurchaseRev: 0, signup: 0, purchaseConv: 0, impr: 0, click: 0
      });
      const o = m.get(key);
      o.spend += g.spend; o.gmv += g.gmv; o.install += g.install; o.firstPurchase += g.firstPurchase;
      o.firstPurchaseRev += g.firstPurchaseRev; o.signup += g.signup; o.purchaseConv += g.purchaseConv;
      o.impr += g.impr; o.click += g.click;
      if (g.status !== "상시") { o.status = g.status; o.promoEnd = g.promoEnd; } // prefer the non-evergreen status when a promo mixes rows
    }
    return [...m.values()];
  }
  function groupByMedia(groups) {
    const m = new Map();
    for (const g of groups) {
      const key = g.media || "(기타)";
      if (!m.has(key)) m.set(key, { media: key, spend: 0, gmv: 0, install: 0, firstPurchase: 0, signup: 0, impr: 0, click: 0, views: 0 });
      const o = m.get(key);
      o.spend += g.spend; o.gmv += g.gmv; o.install += g.install; o.firstPurchase += g.firstPurchase;
      o.signup += g.signup; o.impr += g.impr; o.click += g.click; o.views += (g.views || 0);
    }
    return [...m.values()];
  }
  function topByGmv(list, n) { return [...list].sort((a, b) => b.gmv - a.gmv).slice(0, n); }
  function topByField(list, field, n) { return [...list].filter(p => p[field] > 0).sort((a, b) => b[field] - a[field]).slice(0, n); }
  const promoKey = (p) => (p.brand || "") + "||" + p.promo;

  // Iterates the UNION of A's and B's promo keys, not just B's - a promo that fully
  // ended has zero rows left in B (not a zero-value row, no row at all), so scanning
  // only B's list makes it structurally invisible no matter how big its decline was.
  // This was a real bug: a campaign ending with no residual activity in B (the common
  // case) never showed up as a decliner regardless of how much it explained a drop.
  function decliners(groupsA, groupsB, n, field) {
    field = field || "gmv";
    const A = groupByPromo(groupsA), B = groupByPromo(groupsB);
    const mapA = new Map(A.map(p => [promoKey(p), p]));
    const mapB = new Map(B.map(p => [promoKey(p), p]));
    const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
    const out = [];
    for (const key of allKeys) {
      const pa = mapA.get(key), pb = mapB.get(key);
      const valA = pa ? pa[field] : 0;
      const valB = pb ? pb[field] : 0;
      const delta = valB - valA;
      const minBase = field === "gmv" ? 500000 : 3;
      if (delta < 0 && valA > minBase) {
        const src = pb || pa; // prefer B's copy of brand/promo/status, else fall back to A's
        out.push({ promo: src.promo, brand: src.brand, status: src.status, promoEnd: src.promoEnd, valA, valB, delta, deltaPct: valA > 0 ? (delta / valA * 100) : 0 });
      }
    }
    out.sort((a, b) => a.delta - b.delta);
    return out.slice(0, n);
  }
  // Media-keyed twin of decliners() - some sections (트래픽) reason about media, not
  // promo, so a promo can't be the attribution unit there. Same union-of-keys fix.
  function mediaDecliners(groupsA, groupsB, n, field) {
    field = field || "click";
    const A = groupByMedia(groupsA), B = groupByMedia(groupsB);
    const mapA = new Map(A.map(m => [m.media, m]));
    const mapB = new Map(B.map(m => [m.media, m]));
    const allMedia = new Set([...mapA.keys(), ...mapB.keys()]);
    const out = [];
    for (const media of allMedia) {
      const ma = mapA.get(media), mb = mapB.get(media);
      const valA = ma ? ma[field] : 0;
      const valB = mb ? mb[field] : 0;
      const delta = valB - valA;
      const minBase = field === "spend" || field === "gmv" ? 500000 : 3;
      if (delta < 0 && valA > minBase) {
        out.push({ media, valA, valB, delta, deltaPct: valA > 0 ? (delta / valA * 100) : 0 });
      }
    }
    out.sort((a, b) => a.delta - b.delta);
    return out.slice(0, n);
  }
  function isEndedAround(promoObj, weekARange, weekBRange) {
    if (promoObj.status !== "종료") return false;
    if (!promoObj.promoEnd || promoObj.promoEnd === "상시") return false;
    return promoObj.promoEnd >= weekARange.start && promoObj.promoEnd <= weekBRange.end;
  }

  // ---------- freeform A/B date-range aggregation ----------
  // data.json's groups/promoGroups are day-level (see scripts/export_agg.py) so any
  // date range - including one spanning two month tabs, e.g. 6/29~7/5 - can be
  // re-aggregated here into the exact same shape export_agg.py used to produce for a
  // single "week": one row per (channel, goal, media, brand, promo, status,
  // promoStart, promoEnd), summed across every day in range. Every downstream
  // function (computeRevenueData, groupByPromo, groupByMedia, ...) only cares about
  // that shape, not about weeks, so nothing past this point needs to change.
  function aggregateGroupsByDateRange(rows, start, end) {
    const m = new Map();
    for (const g of rows) {
      if (!g.date || g.date < start || g.date > end) continue;
      const key = [g.channel, g.goal, g.media, g.brand, g.promo, g.status, g.promoStart, g.promoEnd].join("||");
      if (!m.has(key)) m.set(key, {
        channel: g.channel, goal: g.goal, media: g.media, brand: g.brand, promo: g.promo,
        status: g.status, promoStart: g.promoStart, promoEnd: g.promoEnd,
        spend: 0, gmv: 0, impr: 0, click: 0, views: 0,
        firstPurchase: 0, firstPurchaseRev: 0, signup: 0, install: 0, purchaseConv: 0,
      });
      const o = m.get(key);
      o.spend += g.spend; o.gmv += g.gmv; o.impr += g.impr; o.click += g.click; o.views += (g.views || 0);
      o.firstPurchase += g.firstPurchase; o.firstPurchaseRev += (g.firstPurchaseRev || 0); o.signup += g.signup;
      o.install += g.install; o.purchaseConv += g.purchaseConv;
    }
    return [...m.values()];
  }

  // Parallel to aggregateGroupsByDateRange but keyed on (media, campaign, group) -
  // used by the monthly view's "이달 캠페인 세팅 변화" diff (campaignGroups, added
  // to export_agg.py/api/refresh.js specifically for that feature).
  function aggregateCampaignGroupsByDateRange(rows, start, end) {
    const m = new Map();
    for (const g of rows) {
      if (!g.date || g.date < start || g.date > end) continue;
      const key = [g.media, g.campaign, g.group].join("||");
      if (!m.has(key)) m.set(key, {
        media: g.media, rawMedia: g.rawMedia, campaign: g.campaign, group: g.group, goal: g.goal,
        spend: 0, gmv: 0, impr: 0, click: 0, views: 0,
        firstPurchase: 0, signup: 0, install: 0, purchaseConv: 0,
      });
      const o = m.get(key);
      o.spend += g.spend; o.gmv += g.gmv; o.impr += g.impr; o.click += g.click; o.views += (g.views || 0);
      o.firstPurchase += g.firstPurchase; o.signup += g.signup;
      o.install += g.install; o.purchaseConv += g.purchaseConv;
    }
    return [...m.values()];
  }

  // Monthly view compares two whole calendar months (each month tab, e.g. "2607",
  // IS one calendar month) rather than an arbitrary date range - this derives the
  // 1일~말일 bounds for a tab key so the same date-range aggregators above can be reused.
  function monthTabDateRange(tabKey) {
    const yy = tabKey.slice(0, 2), mm = tabKey.slice(2, 4);
    const year = 2000 + parseInt(yy, 10), month = parseInt(mm, 10);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(lastDay).padStart(2, "0")}` };
  }
  function monthTabLabel(tabKey) {
    return `${2000 + parseInt(tabKey.slice(0, 2), 10)}년 ${parseInt(tabKey.slice(2, 4), 10)}월`;
  }

  function shiftDate(dateStr, deltaDays) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d.toISOString().slice(0, 10);
  }
  function clampDate(d, min, max) {
    if (min && d < min) return min;
    if (max && d > max) return max;
    return d;
  }

  // ---------- detail table ----------
  const DETAIL_HEAD = `<tr><th>기획전</th><th>상태</th><th>지출(Gross)</th><th>매출(GMV)</th><th>ROAS</th><th>첫구매</th><th>회원가입</th><th>앱설치</th></tr>`;
  function detailLabel(p) {
    return p.brand ? `${esc(p.brand)} · ${esc(p.promo)}` : esc(p.promo);
  }
  function detailRow(p) {
    if (!p) return "";
    return `<tr>
      <td>${detailLabel(p)}</td>
      <td><span class="status-chip">${esc(p.status || "-")}</span></td>
      <td>${fmtWon(p.spend || 0)}</td>
      <td>${fmtWon(p.gmv || 0)}</td>
      <td>${fmtPct(roas(p.gmv || 0, p.spend || 0))}</td>
      <td>${fmtCount(p.firstPurchase || 0)}</td>
      <td>${fmtCount(p.signup || 0)}</td>
      <td>${fmtCount(p.install || 0)}</td>
    </tr>`;
  }
  function detailTableHtml(rows) {
    if (!rows.length) return `<p class="empty-note">데이터 없음</p>`;
    return `<div class="table-wrap"><table class="detail-table"><thead>${DETAIL_HEAD}</thead><tbody>${rows.map(detailRow).join("")}</tbody></table></div>`;
  }

  // ---------- detail block: rankable by metric, compare view shows independent 전주/금주 BEST lists ----------
  const DETAIL_METRICS = {
    gmv:     { label: "매출(GMV)",   val: p => p.gmv,           fmt: fmtWonAbbrev, unit: "won" },
    install: { label: "앱설치 수",   val: p => p.install,       fmt: fmtCount },
    fp:      { label: "첫구매 수",   val: p => p.firstPurchase, fmt: fmtCount },
    su:      { label: "회원가입 수", val: p => p.signup,        fmt: fmtCount },
  };
  function rankDetail(list, metricKey, n) {
    const val = DETAIL_METRICS[metricKey].val;
    return [...list].sort((a, b) => val(b) - val(a)).slice(0, n);
  }

  const detailBlockState = {}; // idSuffix -> {listA, listB, n, weekALabel, weekBLabel, metricKey}

  function renderDetailSingle(idSuffix) {
    const st = detailBlockState[idSuffix];
    const el = document.getElementById(`detail-single-${idSuffix}`);
    if (!st || !el) return;
    el.innerHTML = detailTableHtml(rankDetail(st.listB, st.metricKey, st.n));
  }

  // Merged/union comparison chart: shows every promo that's in EITHER week's top-N
  // (not just 금주), one row per promo, with 전주/금주 bars paired side by side so the
  // swing is visible at a glance. Ranking 금주 only (the old buildIndependentChart) hid
  // "전주엔 top이었는데 금주에 밀려난 기획전" entirely - the union fixes that, and each
  // row's actual 전주/금주 value comes from the full pool (not just the top-N slice),
  // since a promo pulled in for comparison may sit outside the other week's top-N.
  function buildMergedComparisonChart(listA, listB, metricKey, n, weekALabel, weekBLabel) {
    const metric = DETAIL_METRICS[metricKey];
    const topA = rankDetail(listA, metricKey, n);
    const topB = rankDetail(listB, metricKey, n);
    if (!topA.length && !topB.length) return "";

    const mapA = new Map(listA.map(p => [promoKey(p), p]));
    const mapB = new Map(listB.map(p => [promoKey(p), p]));
    const unionKeys = new Set([...topA, ...topB].map(promoKey));

    let rows = [...unionKeys].map(key => {
      const pa = mapA.get(key) || null;
      const pb = mapB.get(key) || null;
      const valA = pa ? metric.val(pa) : null;
      const valB = pb ? metric.val(pb) : null;
      let state, badge = null;
      if (pa && pb) state = "both";
      else if (pb) state = "new";
      else { state = "dropped"; badge = pa.status === "종료" ? "종료" : "순위이탈"; }
      return { label: detailLabel(pb || pa), valA, valB, state, badge };
    });

    // 금주 값 있는 항목을 먼저(내림차순), 없는 항목(dropped)은 뒤로 몰아 전주값 내림차순.
    rows.sort((r1, r2) => {
      const hasB1 = r1.valB != null, hasB2 = r2.valB != null;
      if (hasB1 !== hasB2) return hasB1 ? -1 : 1;
      if (hasB1) return r2.valB - r1.valB;
      return (r2.valA || 0) - (r1.valA || 0);
    });
    // union can exceed top-N when the two weeks' top lists barely overlap - cap it so the
    // chart doesn't run away; the sort above already puts 금주 값 있는 행을 우선하므로 그대로 자르면 된다.
    rows = rows.slice(0, n * 2);

    const maxVal = Math.max(1, ...rows.map(r => r.valA || 0), ...rows.map(r => r.valB || 0));
    const barPct = (v) => v == null ? 0 : Math.min(100, Math.round((v / maxVal) * 100));
    const bar = (label, cls, v) => v == null ? "" : `<div class="cmp-bar-row"><span class="cmp-bar-tag">${label}</span><div class="chart-track"><div class="chart-fill ${cls}" style="width:${barPct(v)}%"></div></div><span class="chart-value">${metric.fmt(v)}</span></div>`;

    const rowsHtml = rows.map(r => {
      let tag = "";
      if (r.state === "new") tag = `<span class="status-chip chip-new">신규</span>`;
      else if (r.state === "dropped") tag = `<span class="status-chip chip-dropped">${r.badge}</span>`;

      let deltaHtml = "";
      if (r.state === "both") {
        const deltaPct = r.valA > 0 ? ((r.valB - r.valA) / r.valA * 100) : null;
        deltaHtml = deltaSpan(r.valB, r.valA, metric.unit) + (deltaPct != null ? ` <span class="cmp-delta-pct">(${deltaPct >= 0 ? "+" : ""}${Math.round(deltaPct)}%)</span>` : "");
      }

      return `<div class="cmp-row">
        <div class="cmp-row-head"><span class="cmp-row-label">${r.label}</span>${tag}${deltaHtml}</div>
        <div class="cmp-bars">${bar("전주", "prev", r.valA)}${bar("금주", "curr", r.valB)}</div>
      </div>`;
    }).join("");

    return `<div class="compare-chart">
      <div class="chart-title">${esc(metric.label)} · 전주 · ${esc(weekALabel)} vs 금주 · ${esc(weekBLabel)}</div>
      ${rowsHtml}
    </div>`;
  }

  function renderDetailCompare(idSuffix) {
    const st = detailBlockState[idSuffix];
    const el = document.getElementById(`detail-compare-${idSuffix}`);
    if (!st || !el) return;
    const topA = rankDetail(st.listA, st.metricKey, st.n);
    const topB = rankDetail(st.listB, st.metricKey, st.n);
    el.innerHTML = `
      <div class="compare-grid">
        <div><div class="compare-head">전주 BEST · ${esc(st.weekALabel)}</div>${detailTableHtml(topA)}</div>
        <div><div class="compare-head">금주 BEST · ${esc(st.weekBLabel)}</div>${detailTableHtml(topB)}</div>
      </div>
      ${buildMergedComparisonChart(st.listA, st.listB, st.metricKey, st.n, st.weekALabel, st.weekBLabel)}
    `;
  }

  function buildDetailBlock(idSuffix, listB, listA, n, weekALabel, weekBLabel, metricKeys) {
    if (!listB.length && !listA.length) return "";
    metricKeys = metricKeys && metricKeys.length ? metricKeys : ["gmv"];
    detailBlockState[idSuffix] = { listA, listB, n, weekALabel, weekBLabel, metricKey: metricKeys[0] };

    const metricSelectHtml = metricKeys.length > 1
      ? `<select class="detail-metric-select top-metric-select" data-target="${idSuffix}">${metricKeys.map(k => `<option value="${k}">${DETAIL_METRICS[k].label}</option>`).join("")}</select>`
      : "";

    return `<details class="detail" data-detail-id="${idSuffix}">
      <summary>세부 데이터</summary>
      <div class="detail-controls">
        ${metricSelectHtml}
        <label class="toggle-row"><input type="checkbox" class="compare-toggle" data-target="${idSuffix}"> 전주 대비 비교 보기 (전주 BEST / 금주 BEST 각각 표시)</label>
      </div>
      <div id="detail-single-${idSuffix}"></div>
      <div id="detail-compare-${idSuffix}" class="compare-wrap" style="display:none;"></div>
    </details>`;
  }

  function initDetailBlocks() {
    for (const idSuffix of Object.keys(detailBlockState)) {
      renderDetailSingle(idSuffix);
      renderDetailCompare(idSuffix);
    }
  }

  const GOAL_ORDER = ["매출", "신규가입", "앱설치", "트래픽"];

  // ---------- media performance (goal dropdown, A vs B per media, 6 metrics) ----------
  let mediaPerfState = null; // {groupsA, groupsB} for the currently rendered A/B range

  function computeMediaPerformance(groupsA, groupsB, goal) {
    const mediaA = groupByMedia(groupsA.filter(g => g.goal === goal));
    const mediaB = groupByMedia(groupsB.filter(g => g.goal === goal));
    const mapA = new Map(mediaA.map(m => [m.media, m]));
    const mapB = new Map(mediaB.map(m => [m.media, m]));
    const allMedia = new Set([...mapA.keys(), ...mapB.keys()]);
    const empty = { spend: 0, gmv: 0, firstPurchase: 0, signup: 0 };
    const rows = [...allMedia].map(media => ({ media, a: mapA.get(media) || empty, b: mapB.get(media) || empty }));
    rows.sort((r1, r2) => r2.b.spend - r1.b.spend);
    return rows;
  }

  function deltaMeta(valA, valB) {
    const d = valB - valA;
    const cls = d > 0.05 ? "up" : d < -0.05 ? "down" : "flat";
    const arrow = d > 0.05 ? "▲" : d < -0.05 ? "▼" : "－";
    let pct = "";
    if (valA !== 0) pct = `${d >= 0 ? "+" : ""}${Math.round((d / valA) * 100)}%`;
    else if (valB !== 0) pct = "신규";
    return { cls, arrow, pct };
  }

  // Generic "A값 → B값 (▲/▼증감%)" table cell, built on deltaMeta - used by the
  // monthly promo-compare table (and reusable anywhere else an A/B table cell is needed).
  function abCellHtml(valA, valB, fmt) {
    const { cls, arrow, pct } = deltaMeta(valA, valB);
    const pctText = pct ? ` <span class="delta ${cls}">${arrow}${pct === "신규" ? "(신규)" : `(${pct})`}</span>` : "";
    return `${fmt(valA)} → ${fmt(valB)}${pctText}`;
  }

  // headline metric (GMV/ROAS): big current value + small "이전 A값 (증감)" line underneath
  function mediaHeadlineStat(label, valA, valB, fmt) {
    const { cls, arrow, pct } = deltaMeta(valA, valB);
    return `<div class="m-stat">
      <div class="m-primary"><span class="k">${label}</span><span class="v">${fmt(valB)}</span></div>
      <div class="m-secondary"><span class="k">${arrow} 이전 ${fmt(valA)}</span><span class="v delta ${cls}">${pct}</span></div>
    </div>`;
  }

  // secondary metric row (첫구매/CPA/가입/CPA): compact "A값 → B값 (▲증감%)", or an opts.na override
  function mediaSubRowHtml(label, valA, valB, fmt, opts) {
    opts = opts || {};
    if (opts.na) {
      return `<div class="m-sub-row"><span class="lbl">${label}</span><span class="cell-na">${opts.na}</span></div>`;
    }
    const { cls, arrow, pct } = deltaMeta(valA, valB);
    const pctText = pct ? ` <span class="delta ${cls}">${arrow}${pct === "신규" ? "(신규)" : `(${pct})`}</span>` : "";
    return `<div class="m-sub-row"><span class="lbl">${label}</span><span>${fmt(valA)} → ${fmt(valB)}${pctText}</span></div>`;
  }

  function renderMediaPerformance(goal) {
    const body = document.getElementById("mediaPerfBody");
    if (!body || !mediaPerfState) return;
    const rows = computeMediaPerformance(mediaPerfState.groupsA, mediaPerfState.groupsB, goal);
    if (!rows.length) { body.innerHTML = `<p class="empty-note">이 목표에는 매체 데이터가 없습니다.</p>`; return; }

    const cards = rows.map(({ media, a, b }) => {
      const roasA = roas(a.gmv, a.spend), roasB = roas(b.gmv, b.spend);
      // ASA는 매체 구조상 첫구매/회원가입 집계가 원천적으로 불가능하다 (앱설치 섹션과 동일한 규칙).
      const naAll = UNSUPPORTED_FP_SU_MEDIA.includes(media);
      const fpCpaValid = !naAll && a.firstPurchase > 0 && b.firstPurchase > 0;
      const suCpaValid = !naAll && a.signup > 0 && b.signup > 0;
      const subRows = [
        mediaSubRowHtml("첫구매", a.firstPurchase, b.firstPurchase, fmtCount, { na: naAll ? "(수집 불가)" : null }),
        mediaSubRowHtml("첫구매 CPA", a.spend / a.firstPurchase, b.spend / b.firstPurchase, fmtWon, { na: naAll ? "(수집 불가)" : (fpCpaValid ? null : "-") }),
        mediaSubRowHtml("회원가입", a.signup, b.signup, fmtCount, { na: naAll ? "(수집 불가)" : null }),
        mediaSubRowHtml("가입 CPA", a.spend / a.signup, b.spend / b.signup, fmtWon, { na: naAll ? "(수집 불가)" : (suCpaValid ? null : "-") }),
      ].join("");

      return `<div class="media-card">
        <div class="m-name">${esc(media)}</div>
        ${mediaHeadlineStat("GMV", a.gmv, b.gmv, fmtWonAbbrev)}
        ${mediaHeadlineStat("ROAS", roasA, roasB, fmtPct)}
        <hr>
        ${subRows}
      </div>`;
    }).join("");

    body.innerHTML = `<div class="card-grid">${cards}</div>`;
  }

  function buildMediaPerformanceSection(groupsA, groupsB) {
    const goals = GOAL_ORDER.filter(g => groupsA.some(x => x.goal === g) || groupsB.some(x => x.goal === g));
    if (!goals.length) return "";
    mediaPerfState = { groupsA, groupsB };
    const defaultGoal = goals.includes("매출") ? "매출" : goals[0];
    const goalOptions = goals.map(g => `<option value="${g}"${g === defaultGoal ? " selected" : ""}>${g}</option>`).join("");

    return `
    <section class="section-card" data-ch="MEDIA">
      <div class="section-title">
        <span class="tag">MEDIA</span><h3>매체 성과</h3>
        <select id="mediaGoalSelect" class="top-metric-select">${goalOptions}</select>
      </div>
      <div id="mediaPerfBody"></div>
    </section>`;
  }

  // ---------- section builders (organized by BL 목표, not channel) ----------
  function kpiTile(label, valueStr, deltaHtml) {
    return `<div class="kpi"><div class="label">${label}</div><div class="value">${valueStr}</div>${deltaHtml ? `<div>${deltaHtml}</div>` : ""}</div>`;
  }

  const commentLoadingHtml = () => `<p class="ai-loading">AI 코멘트 생성 중...</p>`;
  function commentErrorHtml(msg) {
    return `<p class="ai-error">AI 코멘트를 가져오지 못했습니다. (${esc(msg)})</p><button type="button" class="retry-btn" data-action="retry-comments">다시 시도</button>`;
  }

  // ---------- 매출 (목표=매출) ----------
  // 이 기획전은 거의 매주 매출 기여도가 가장 높게 나오는 상시성 캠페인이라, 늘 상위권을
  // 차지해서 "그 주에 실제로 무슨 일이 있었는지"를 가려버린다 - AI 코멘트에 이 기획전을
  // 제외했을 때의 매출 증감도 같이 계산해서 줘서, 그 뒤에 가려진 실제 변동 요인을 짚어주게 한다.
  const REVENUE_EVERGREEN_PROMO = { brand: "통합", promo: "1만원이상_시즌" };

  function computeRevenueData(groupsA, groupsB, weekARange, weekBRange) {
    const isRev = g => g.goal === "매출";
    const revA = groupsA.filter(isRev), revB = groupsB.filter(isRev);

    const spendA = sum(revA, "spend"), gmvA = sum(revA, "gmv");
    const spendB = sum(revB, "spend"), gmvB = sum(revB, "gmv");
    const roasA = roas(gmvA, spendA), roasB = roas(gmvB, spendB);
    const fpA = sum(revA, "firstPurchase"), fpB = sum(revB, "firstPurchase");
    const suA = sum(revA, "signup"), suB = sum(revB, "signup");

    const revDecliners = decliners(revA, revB, 3, "gmv").map(d => ({ ...d, ended: isEndedAround(d, weekARange, weekBRange) }));
    // GMV 기준 decliners만으로는 "첫구매/회원가입" 리드가 근거로 쓸 데이터가 없어서, 그
    // 지표가 실제로 하락한 이유를 AI가 알 방법이 없었다 (예: 캠페인 종료로 첫구매/회원가입이
    // 크게 빠졌는데 GMV decliners엔 안 잡히는 경우) - 지표별로 따로 계산해서 넘긴다.
    const fpDecliners = decliners(revA, revB, 3, "firstPurchase").map(d => ({ ...d, ended: isEndedAround(d, weekARange, weekBRange) }));
    const suDecliners = decliners(revA, revB, 3, "signup").map(d => ({ ...d, ended: isEndedAround(d, weekARange, weekBRange) }));

    // KPF has its own subsection (kept fully deterministic, see buildKpfLead), so it's
    // excluded from the general promo pool used for both the table and the AI prompt.
    const detailPoolB = groupByPromo(revB.filter(g => g.channel !== "KPF"));
    const detailPoolA = groupByPromo(revA.filter(g => g.channel !== "KPF"));
    const top3Revenue = topByGmv(detailPoolB, 3).map(p => ({ brand: p.brand, promo: p.promo, gmv: p.gmv, sharePct: shareOf(p.gmv, gmvB) }));

    const isEvergreen = g => g.brand === REVENUE_EVERGREEN_PROMO.brand && g.promo === REVENUE_EVERGREEN_PROMO.promo;
    const revAExclEvergreen = revA.filter(g => !isEvergreen(g));
    const revBExclEvergreen = revB.filter(g => !isEvergreen(g));
    const gmvAExclEvergreen = sum(revAExclEvergreen, "gmv"), gmvBExclEvergreen = sum(revBExclEvergreen, "gmv");
    const gmvDeltaPctExclEvergreen = gmvAExclEvergreen > 0 ? ((gmvBExclEvergreen - gmvAExclEvergreen) / gmvAExclEvergreen * 100) : null;
    const declinersExclEvergreen = decliners(revAExclEvergreen, revBExclEvergreen, 3, "gmv").map(d => ({ ...d, ended: isEndedAround(d, weekARange, weekBRange) }));
    const top3ExclEvergreen = topByGmv(groupByPromo(revBExclEvergreen.filter(g => g.channel !== "KPF")), 3)
      .map(p => ({ brand: p.brand, promo: p.promo, gmv: p.gmv, sharePct: shareOf(p.gmv, gmvBExclEvergreen) }));

    return {
      detailPoolB, detailPoolA,
      kpiTiles: { roasA, roasB, gmvA, gmvB, fpB, suB },
      prompt: {
        spendA, gmvA, roasA, spendB, gmvB, roasB, fpA, fpB, suA, suB, decliners: revDecliners, top3: top3Revenue,
        fpDecliners, suDecliners,
        evergreenPromo: `${REVENUE_EVERGREEN_PROMO.brand} · ${REVENUE_EVERGREEN_PROMO.promo}`,
        gmvAExclEvergreen, gmvBExclEvergreen, gmvDeltaPctExclEvergreen,
        declinersExclEvergreen, top3ExclEvergreen,
      },
    };
  }

  // KPF highlights are a cumulative, fully-deterministic log of every KPF send in this
  // tab (not scoped to the selected week), in chronological order - never AI-generated.
  function buildKpfLead() {
    const kpfHi = groupByPromo(DATA_CURRENT.groups.filter(g => g.channel === "KPF"))
      .sort((a, b) => (a.promoStart || "").localeCompare(b.promoStart || ""));
    if (!kpfHi.length) return null;
    return {
      title: "매출_KPF 상세성과",
      // AI를 거치지 않는 규칙 기반 리드이므로 basis는 항상 "data" 고정.
      details: kpfHi.map(p => ({ text: `${fmtDate(p.promoStart)} [${p.brand} · ${p.promo}] 소재 발송, 구매 ${fmtCount(p.purchaseConv)}, 매출 ${fmtWonAbbrev(p.gmv)}, ROAS ${fmtPct(roas(p.gmv, p.spend))} 기록`, basis: "data" })),
    };
  }

  function buildRevenueSection(groupsA, groupsB, weekARange, weekBRange, weekALabel, weekBLabel) {
    const d = computeRevenueData(groupsA, groupsB, weekARange, weekBRange);
    return {
      html: `
    <section class="section-card" data-ch="매출">
      <div class="section-title"><span class="tag">매출</span><h3>매출 성과</h3></div>
      <div class="kpis">
        ${kpiTile("매출 ROAS (B주)", fmtPct(d.kpiTiles.roasB), deltaSpan(d.kpiTiles.roasB, d.kpiTiles.roasA, "pp"))}
        ${kpiTile("매출(GMV)", fmtWonAbbrev(d.kpiTiles.gmvB), deltaSpan(d.kpiTiles.gmvB, d.kpiTiles.gmvA, "won"))}
        ${kpiTile("첫구매", fmtCount(d.kpiTiles.fpB))}
        ${kpiTile("회원가입", fmtCount(d.kpiTiles.suB))}
      </div>
      <div class="comment" id="comment-매출">${commentLoadingHtml()}</div>
      ${buildDetailBlock("rev", d.detailPoolB, d.detailPoolA, 10, weekALabel, weekBLabel, ["gmv", "fp", "su"])}
    </section>`,
      promptData: d.prompt,
    };
  }

  // ---------- 신규가입 (목표=신규가입) ----------
  function computeSignupData(groupsA, groupsB, weekARange, weekBRange) {
    const isSignup = g => g.goal === "신규가입";
    const suGA = groupsA.filter(isSignup), suGB = groupsB.filter(isSignup);

    const suSpendA = sum(suGA, "spend"), suGmvA = sum(suGA, "gmv");
    const suSpendB = sum(suGB, "spend"), suGmvB = sum(suGB, "gmv");
    const suRoasA = roas(suGmvA, suSpendA), suRoasB = roas(suGmvB, suSpendB);
    const suFpA = sum(suGA, "firstPurchase"), suFpB = sum(suGB, "firstPurchase");
    const suSuA = sum(suGA, "signup"), suSuB = sum(suGB, "signup");
    const suCppA = suFpA > 0 ? suSpendA / suFpA : 0, suCppB = suFpB > 0 ? suSpendB / suFpB : 0;
    const suCpaA = suSuA > 0 ? suSpendA / suSuA : 0, suCpaB = suSuB > 0 ? suSpendB / suSuB : 0;

    // 리드마다 근거가 필요한 지표가 다르다 - "매출" 리드는 GMV 기준, "첫구매/신규가입"
    // 리드는 첫구매·신규가입 기준으로 각각 무엇이 하락했는지 알아야 하므로 지표별로 따로 계산한다.
    const gmvDecliners = decliners(suGA, suGB, 3, "gmv").map(d => ({ ...d, ended: isEndedAround(d, weekARange, weekBRange) }));
    const fpDecliners = decliners(suGA, suGB, 3, "firstPurchase").map(d => ({ ...d, ended: isEndedAround(d, weekARange, weekBRange) }));
    const suDecliners = decliners(suGA, suGB, 3, "signup").map(d => ({ ...d, ended: isEndedAround(d, weekARange, weekBRange) }));

    const detailPoolB = groupByPromo(suGB);
    const detailPoolA = groupByPromo(suGA);
    const topSignupPromosB = topByField(detailPoolB, "signup", 3).map(p => ({ brand: p.brand, promo: p.promo, signup: p.signup, sharePct: shareOf(p.signup, suSuB) }));

    return {
      detailPoolB, detailPoolA,
      kpiTiles: { roasA: suRoasA, roasB: suRoasB, gmvA: suGmvA, gmvB: suGmvB, fpB: suFpB, suB: suSuB },
      prompt: {
        spendA: suSpendA, gmvA: suGmvA, roasA: suRoasA, spendB: suSpendB, gmvB: suGmvB, roasB: suRoasB,
        fpA: suFpA, fpB: suFpB, suA: suSuA, suB: suSuB, cppA: suCppA, cppB: suCppB, cpaA: suCpaA, cpaB: suCpaB,
        gmvDecliners, fpDecliners, suDecliners, topSignupPromos: topSignupPromosB,
      },
    };
  }

  function buildSignupSection(groupsA, groupsB, weekARange, weekBRange, weekALabel, weekBLabel) {
    const d = computeSignupData(groupsA, groupsB, weekARange, weekBRange);
    return {
      html: `
    <section class="section-card" data-ch="신규가입">
      <div class="section-title"><span class="tag">신규가입</span><h3>신규가입 성과</h3></div>
      <div class="kpis">
        ${kpiTile("신규가입 ROAS (B주)", fmtPct(d.kpiTiles.roasB), deltaSpan(d.kpiTiles.roasB, d.kpiTiles.roasA, "pp"))}
        ${kpiTile("매출(GMV)", fmtWonAbbrev(d.kpiTiles.gmvB), deltaSpan(d.kpiTiles.gmvB, d.kpiTiles.gmvA, "won"))}
        ${kpiTile("첫구매", fmtCount(d.kpiTiles.fpB))}
        ${kpiTile("회원가입", fmtCount(d.kpiTiles.suB))}
      </div>
      <div class="comment" id="comment-신규가입">${commentLoadingHtml()}</div>
      ${buildDetailBlock("signup", d.detailPoolB, d.detailPoolA, 10, weekALabel, weekBLabel, ["gmv", "fp", "su"])}
    </section>`,
      promptData: d.prompt,
    };
  }

  // ---------- 앱설치 (목표=앱설치) ----------
  // ASA(Apple Search Ads)는 매체 구조상 첫구매/회원가입을 애초에 수집할 수 없다 - 값이
  // 우연히 0이라서가 아니라 트래킹 자체가 안 되기 때문. Google은 정상적으로 수집 가능하다.
  // 그래서 "값이 0인 매체"를 동적으로 추론하는 대신, 이 상수로 명시적으로 고정한다.
  const UNSUPPORTED_FP_SU_MEDIA = ["Apple Search Ads"];

  function computeAppData(groupsA, groupsB, weekARange, weekBRange) {
    const appA = groupsA.filter(g => g.goal === "앱설치"), appB = groupsB.filter(g => g.goal === "앱설치");
    const installA = sum(appA, "install"), installB = sum(appB, "install");
    const spendA = sum(appA, "spend"), spendB = sum(appB, "spend");
    const cpiA = cpi_(spendA, installA), cpiB = cpi_(spendB, installB);
    const gmvA = sum(appA, "gmv"), gmvB = sum(appB, "gmv");
    const roasA = roas(gmvA, spendA), roasB = roas(gmvB, spendB);
    const fpA = sum(appA, "firstPurchase"), fpB = sum(appB, "firstPurchase");
    const suA = sum(appA, "signup"), suB = sum(appB, "signup");

    const mediaB = groupByMedia(appB).sort((a, b) => b.install - a.install);
    const mediaA = groupByMedia(appA);
    const mediaBreakdown = mediaB.map(m => {
      const prev = mediaA.find(x => x.media === m.media);
      return {
        media: m.media, installA: prev ? prev.install : 0, installB: m.install,
        gmvA: prev ? prev.gmv : 0, gmvB: m.gmv, spendA: prev ? prev.spend : 0, spendB: m.spend,
        firstPurchase: m.firstPurchase, signup: m.signup,
      };
    });
    const unsupportedFpSuMedia = mediaB.filter(m => UNSUPPORTED_FP_SU_MEDIA.includes(m.media)).map(m => m.media);

    // 기획전 단위 상세 비교는 Google(AC) 매체 데이터만 사용한다: ASA는 기획전명이 전부 "iOS" 하나로
    // 뭉뚱그려져 있어 기획전별 비교가 불가능하기 때문 (AC는 기획전별로 실제 캠페인이 나뉘어 있음).
    const appPromoA = appA.filter(g => g.media === "Google");
    const appPromoB = appB.filter(g => g.media === "Google");
    const promoInstallB = groupByPromo(appPromoB).sort((a, b) => b.install - a.install);
    const topInstallPromos = promoInstallB.slice(0, 3).map(p => ({ brand: p.brand, promo: p.promo, install: p.install, sharePct: shareOf(p.install, installB) }));

    const detailPoolB = groupByPromo(appPromoB);
    const detailPoolA = groupByPromo(appPromoA);
    const topGmvPromos = topByGmv(detailPoolB, 3).map(p => ({ brand: p.brand, promo: p.promo, gmv: p.gmv, sharePct: shareOf(p.gmv, gmvB) }));

    // topInstallPromos/topGmvPromos만으로는 "B기간에 잘한 것"만 보이고, 기획전이 완전히
    // 종료돼서 이번 기간엔 0에 가까운 경우는 top-N에서 아예 빠져 사라진 이유를 알 수 없다 -
    // 리드별로 실제 하락 요인을 짚을 수 있게 지표마다 decliners를 따로 계산한다.
    const installDecliners = decliners(appPromoA, appPromoB, 3, "install").map(d => ({ ...d, ended: isEndedAround(d, weekARange, weekBRange) }));
    const gmvDecliners = decliners(appPromoA, appPromoB, 3, "gmv").map(d => ({ ...d, ended: isEndedAround(d, weekARange, weekBRange) }));
    const fpDecliners = decliners(appPromoA, appPromoB, 3, "firstPurchase").map(d => ({ ...d, ended: isEndedAround(d, weekARange, weekBRange) }));
    const suDecliners = decliners(appPromoA, appPromoB, 3, "signup").map(d => ({ ...d, ended: isEndedAround(d, weekARange, weekBRange) }));

    return {
      detailPoolB, detailPoolA,
      kpiTiles: { installA, installB, cpiA, cpiB, roasA, roasB, fpB, suB },
      prompt: {
        installA, installB, cpiA, cpiB, spendA, spendB, gmvA, gmvB, roasA, roasB, fpA, fpB, suA, suB,
        mediaBreakdown, unsupportedFpSuMedia, topInstallPromos, topGmvPromos,
        installDecliners, gmvDecliners, fpDecliners, suDecliners,
      },
    };
  }

  function buildAppSection(groupsA, groupsB, weekARange, weekBRange, weekALabel, weekBLabel) {
    const d = computeAppData(groupsA, groupsB, weekARange, weekBRange);
    return {
      html: `
    <section class="section-card" data-ch="앱설치">
      <div class="section-title"><span class="tag">앱설치</span><h3>앱설치 성과</h3></div>
      <p class="scope-note">기획전 단위 비교는 Google(AC) 기준으로만 집계됩니다. ASA는 기획전별 구분 없이 전체 합계(위 KPI)에만 반영됩니다.<br>ASA(Apple Search Ads)는 매체 특성상 첫구매·회원가입 수집이 원천적으로 불가능하고, Google은 수집 가능합니다.</p>
      <div class="kpis">
        ${kpiTile("CPI", fmtWon(d.kpiTiles.cpiB), deltaSpan(d.kpiTiles.cpiB, d.kpiTiles.cpiA, "won"))}
        ${kpiTile("앱설치", fmtCount(d.kpiTiles.installB), deltaSpan(d.kpiTiles.installB, d.kpiTiles.installA, "count"))}
        ${kpiTile("ROAS", fmtPct(d.kpiTiles.roasB), deltaSpan(d.kpiTiles.roasB, d.kpiTiles.roasA, "pp"))}
        ${kpiTile("첫구매/가입", `${fmtNum(d.kpiTiles.fpB)}/${fmtNum(d.kpiTiles.suB)}`)}
      </div>
      <div class="comment" id="comment-앱설치">${commentLoadingHtml()}</div>
      ${buildDetailBlock("app", d.detailPoolB, d.detailPoolA, 8, weekALabel, weekBLabel, ["gmv", "install", "fp", "su"])}
    </section>`,
      promptData: d.prompt,
    };
  }

  // ---------- 트래픽 (목표=트래픽) ----------
  function computeTrafficData(groupsA, groupsB, weekARange, weekBRange) {
    const trA = groupsA.filter(g => g.goal === "트래픽"), trB = groupsB.filter(g => g.goal === "트래픽");
    if (!trB.length) return null;

    const clickB = sum(trB, "click"), imprB = sum(trB, "impr"), spendB = sum(trB, "spend");
    const clickA = sum(trA, "click"), imprA = sum(trA, "impr"), spendA = sum(trA, "spend");
    const ctrB = ctr_(clickB, imprB), cpcB = cpc_(spendB, clickB);
    const ctrA = ctr_(clickA, imprA), cpcA = cpc_(spendA, clickA);
    const gmvB = sum(trB, "gmv"), gmvA = sum(trA, "gmv");
    const roasB = roas(gmvB, spendB), roasA = roas(gmvA, spendA);
    const fpA = sum(trA, "firstPurchase"), fpB = sum(trB, "firstPurchase");
    const suA = sum(trA, "signup"), suB = sum(trB, "signup");
    const viewsB = sum(trB, "views"), viewsA = sum(trA, "views");

    const mediaB = groupByMedia(trB).sort((a, b) => b.spend - a.spend);
    const mediaList = mediaB.map(m => m.media);
    const topMediaByGmv = [...mediaB].sort((a, b) => b.gmv - a.gmv)[0];
    // topMediaByGmv/mediaList는 B기간 현재 상태만 보여줘서, 클릭이 줄어든 이유(어떤 매체가
    // 빠졌는지)를 설명 못 한다 - "트래픽" 리드가 쓸 매체 단위 decliners를 별도로 계산한다.
    const clickDecliners = mediaDecliners(trA, trB, 3, "click");

    // 세부 데이터는 매체가 아니라 브랜드/기획전 단위로 보여준다 (매체는 AI 코멘트에서만 언급).
    const detailPoolB = groupByPromo(trB);
    const detailPoolA = groupByPromo(trA);
    // "매출"/"첫구매/회원가입" 리드는 기획전 단위 하락 요인이 필요하다 (매체 단위 decliners와는 별개).
    const gmvDecliners = decliners(trA, trB, 3, "gmv");
    const fpDecliners = decliners(trA, trB, 3, "firstPurchase");
    const suDecliners = decliners(trA, trB, 3, "signup");

    return {
      detailPoolB, detailPoolA,
      kpiTiles: { ctrA, ctrB, cpcA, cpcB, roasA, roasB, fpB, suB, viewsA, viewsB },
      prompt: {
        ctrA, ctrB, cpcA, cpcB, viewsA, viewsB, gmvA, gmvB, roasA, roasB, fpA, fpB, suA, suB, spendA, spendB,
        mediaList, topMediaByGmv: topMediaByGmv ? topMediaByGmv.media : null,
        clickDecliners, gmvDecliners, fpDecliners, suDecliners,
      },
    };
  }

  function buildTrafficSection(groupsA, groupsB, weekARange, weekBRange, weekALabel, weekBLabel) {
    const d = computeTrafficData(groupsA, groupsB, weekARange, weekBRange);
    if (!d) {
      return {
        html: `<section class="section-card" data-ch="트래픽">
          <div class="section-title"><span class="tag">트래픽</span><h3>트래픽 성과</h3></div>
          <p class="empty-note">선택한 B주차에는 목표=트래픽으로 분류된 캠페인 데이터가 없습니다.</p>
        </section>`,
        promptData: null,
      };
    }
    return {
      html: `
    <section class="section-card" data-ch="트래픽">
      <div class="section-title"><span class="tag">트래픽</span><h3>트래픽 성과</h3></div>
      <div class="kpis">
        ${kpiTile("CTR", fmtPct2(d.kpiTiles.ctrB), deltaSpan(d.kpiTiles.ctrB, d.kpiTiles.ctrA, "pp"))}
        ${kpiTile("CPC", fmtWon(d.kpiTiles.cpcB), deltaSpan(d.kpiTiles.cpcB, d.kpiTiles.cpcA, "won"))}
        ${kpiTile("조회수", fmtNum(d.kpiTiles.viewsB), deltaSpan(d.kpiTiles.viewsB, d.kpiTiles.viewsA, "count"))}
        ${kpiTile("ROAS", fmtPct(d.kpiTiles.roasB), deltaSpan(d.kpiTiles.roasB, d.kpiTiles.roasA, "pp"))}
        ${kpiTile("첫구매/가입", `${fmtNum(d.kpiTiles.fpB)}/${fmtNum(d.kpiTiles.suB)}`)}
      </div>
      <div class="comment" id="comment-트래픽">${commentLoadingHtml()}</div>
      ${buildDetailBlock("traffic", d.detailPoolB, d.detailPoolA, 8, weekALabel, weekBLabel, ["gmv", "fp", "su"])}
    </section>`,
      promptData: d.prompt,
    };
  }

  // ---------- render AI-generated leads into the .comment placeholders ----------
  const SECTION_TAGS = ["매출", "신규가입", "앱설치", "트래픽"];

  // [기획전명] / [브랜드 · 기획전명] style bracket mentions get highlighted - safe to
  // run after esc() since escaping never touches literal "[" / "]" characters.
  function highlightBrackets(escapedText) {
    return escapedText.replace(/\[([^\[\]]+)\]/g, '<span class="promo">[$1]</span>');
  }
  // Each detail is a small badge dot showing what grounds that sentence: a plain
  // computed number (data), the user's 특이사항 메모 (note), or an AI guess with no
  // data/note backing it (inference) - lets a reviewer tell "this is just the numbers"
  // from "this is the model's own interpretation" at a glance.
  const BASIS_LABEL = { data: "데이터 수치 기반", note: "특이사항 메모 기반 해석", inference: "AI 추정·해석 (근거 데이터 없음)" };
  function basisDotHtml(basis) {
    const key = BASIS_LABEL[basis] ? basis : "data";
    return `<span class="basis-dot basis-${key}" title="${esc(BASIS_LABEL[key])}"></span>`;
  }
  // The basis dot is the only bullet marker a detail line should show - but the
  // model occasionally still writes a literal "· "/"• " prefix into the text itself
  // (despite being told not to), which then doubles up with the dot. Strip it
  // defensively so a rendering/copy bug isn't at the mercy of prompt compliance.
  function stripLeadingBullet(text) {
    return String(text).replace(/^[\s]*[·•∙‧-]\s*/, "");
  }
  function renderLeadsHtml(leads) {
    return `<ul>${leads.map(lead => `<li><b class="lead">${esc(lead.title)}</b>
      <ul>${lead.details.map(detail => `<li>${basisDotHtml(detail.basis)}${highlightBrackets(esc(stripLeadingBullet(detail.text))).replace(/\n/g, "<br>")}</li>`).join("")}</ul>
    </li>`).join("")}</ul>`;
  }

  function renderComments(json) {
    lastComments = json; // {sections: [{tag, leads}]} - kept for the copy button, KPF already spliced in
    for (const tag of SECTION_TAGS) {
      const el = document.getElementById(`comment-${tag}`);
      if (!el) continue;
      const section = json.sections.find(s => s.tag === tag);
      if (!section || !section.leads.length) {
        el.innerHTML = `<p class="empty-note">코멘트를 생성하지 못했습니다.</p>`;
        continue;
      }
      el.innerHTML = renderLeadsHtml(section.leads);
    }
  }

  function renderCommentsError(err) {
    const msg = String((err && err.message) || err);
    for (const tag of SECTION_TAGS) {
      const el = document.getElementById(`comment-${tag}`);
      if (el) el.innerHTML = commentErrorHtml(msg);
    }
  }

  // ---------- plain-text export (for copy button) - built from the same JSON as the HTML ----------
  // [INSIGHT] (우수 기획전 TOP5) stays visible on screen but is intentionally left out of
  // the copied text - the copy button is for the 매출/신규가입/앱설치/트래픽 comments only.
  function commentsToPlainText() {
    let out = "";
    if (lastComments) {
      for (const tag of SECTION_TAGS) {
        const section = lastComments.sections.find(s => s.tag === tag);
        if (!section || !section.leads.length) continue;
        out += `[${tag}]\n`;
        for (const lead of section.leads) {
          out += `l  ${lead.title}\n`;
          for (const detail of lead.details) {
            // Plain-text export stays basis-badge-free - the dots are a screen-only aid.
            // stripLeadingBullet() avoids a doubled "·  · ..." if the model included one itself.
            const lines = stripLeadingBullet(detail.text).split("\n");
            out += `·  ${lines[0]}\n`;
            for (let i = 1; i < lines.length; i++) out += `${lines[i]}\n`;
          }
        }
        out += "\n";
      }
    }
    return out.trim();
  }

  // ---------- AI call ----------
  let lastComments = null;
  let lastPromptPayload = null;

  async function requestAIComments(payload) {
    lastPromptPayload = payload;
    for (const tag of SECTION_TAGS) {
      const el = document.getElementById(`comment-${tag}`);
      if (el) el.innerHTML = commentLoadingHtml();
    }
    try {
      const res = await fetch("/api/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      // Splice the deterministic KPF lead into 매출 right after the "매출" lead, if present.
      const kpfLead = buildKpfLead();
      if (kpfLead) {
        const revSection = json.sections.find(s => s.tag === "매출");
        if (revSection) {
          const idx = revSection.leads.findIndex(l => l.title === "매출");
          revSection.leads.splice(idx >= 0 ? idx + 1 : 0, 0, kpfLead);
        }
      }
      renderComments(json);
      notifySlackIfEnabled();
    } catch (err) {
      renderCommentsError(err);
    }
  }

  // "완료 시 Slack 알림 받기" - fires once the report comment successfully renders (not
  // on failure, since there's nothing useful to report yet). Reuses commentsToPlainText()
  // so the Slack message matches the "코멘트 복사" button byte-for-byte.
  async function notifySlackIfEnabled() {
    const checkbox = document.getElementById("slackNotifyCheckbox");
    const status = document.getElementById("slackNotifyStatus");
    if (!checkbox || !checkbox.checked) return;
    const text = commentsToPlainText();
    if (!text.trim()) return; // nothing to send (e.g. comment fetch itself failed)
    status.textContent = "전송 중...";
    status.classList.remove("error");
    try {
      const res = await fetch("/api/notify-slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      status.textContent = "전송됨";
    } catch (err) {
      status.textContent = "전송 실패";
      status.classList.add("error");
      status.title = String((err && err.message) || err);
    }
  }

  // ---------- Q&A panel (free-form questions grounded in RAW group data) ----------
  // Separate from the auto-generated report comments (/api/comment). The client keeps
  // its own {role, content} turn history and resends it every call, since Vercel
  // functions have no server-side session.
  //
  // Token/cost control has two complementary layers that apply to different phases
  // of the same conversation rather than both at once:
  //  - Every turn sends a small "scoped" slice of the data - filtered to the goal(s)
  //    the question actually seems to be about, aggregated to brand+promo, with
  //    goal-irrelevant fields dropped. This is what answers turn 1, and it's also
  //    what the server falls back to if a held cache turns out to be invalid.
  //  - From turn 2 onward (once there's at least one prior Q+A pair), the client
  //    additionally attaches the FULL unfiltered dataset once so the server can seed
  //    a Gemini context cache from it. Every later turn then just references that
  //    cache by name instead of resending anything data-shaped - cheap regardless of
  //    which goal the new question touches, since the cache already covers all of
  //    them. A cache only helps if its content is byte-identical across reuses, which
  //    is exactly why it's built from the full data rather than a per-question slice.
  let qaHistory = [];    // {role: "user"|"model", content: string}[] sent to the API
  let qaContext = null;  // {tab, weekLabels, groups, promoGroups} scoped to the loaded A/B weeks
  let qaCacheName = null; // Gemini cache resource name once the server has created one, else null

  const QA_GOAL_KEYWORDS = {
    "매출": ["매출", "gmv", "구매"],
    "신규가입": ["신규가입", "회원가입", "가입", "signup"],
    "앱설치": ["앱설치", "설치", "install", "cpi"],
    "트래픽": ["트래픽", "유입", "ctr", "cpc", "클릭", "조회"],
  };
  const QA_MEDIA_NAMES = ["Google", "Apple Search Ads", "Facebook", "Kakaomoment", "Naver", "NaverGFA", "ChatGPT"];

  function detectQaScope(question, groups) {
    const goalHits = new Set();
    for (const [goal, kws] of Object.entries(QA_GOAL_KEYWORDS)) {
      if (kws.some(kw => question.includes(kw))) goalHits.add(goal);
    }
    const brands = new Set(), promos = new Set();
    for (const g of groups) { if (g.brand) brands.add(g.brand); if (g.promo) promos.add(g.promo); }
    for (const b of brands) if (b && question.includes(b)) groups.filter(g => g.brand === b).forEach(g => goalHits.add(g.goal));
    for (const p of promos) if (p && question.includes(p)) groups.filter(g => g.promo === p).forEach(g => goalHits.add(g.goal));
    // 아무 목표/브랜드/기획전 신호도 없으면(포괄적 질문) 4개 목표 전부 포함한다 -
    // 데이터 누락으로 "모릅니다"가 늘어나는 것보다 약간의 토큰 낭비가 낫다.
    const goals = goalHits.size ? [...goalHits] : GOAL_ORDER.slice();
    const wantsMaterial = question.includes("소재");
    const wantsMediaDetail = QA_MEDIA_NAMES.some(m => question.includes(m)) || question.includes("매체") || question.includes("채널");
    return { goals, wantsMaterial, wantsMediaDetail };
  }

  // 브랜드+기획전 단위로 집계하되 기간(A/B) 구분은 남긴다 - groupByPromo는 리포트 섹션(항상
  // 한 기간씩 다룸)용이라 기간을 뭉개는데, Q&A는 A/B 두 기간을 한 번에 다루니 구분이 있어야 한다.
  function qaGroupByPeriodPromo(groups) {
    const m = new Map();
    for (const g of groups) {
      const key = `${g.period}||${g.brand || ""}||${g.promo || "(미지정)"}`;
      if (!m.has(key)) m.set(key, {
        period: g.period, goal: g.goal, brand: g.brand, promo: g.promo || "(미지정)",
        status: g.status, promoStart: g.promoStart, promoEnd: g.promoEnd,
        spend: 0, gmv: 0, install: 0, firstPurchase: 0, signup: 0, purchaseConv: 0, impr: 0, click: 0,
      });
      const o = m.get(key);
      o.spend += g.spend; o.gmv += g.gmv; o.install += g.install; o.firstPurchase += g.firstPurchase;
      o.signup += g.signup; o.purchaseConv += g.purchaseConv; o.impr += g.impr; o.click += g.click;
      if (g.status !== "상시") { o.status = g.status; o.promoEnd = g.promoEnd; }
    }
    return [...m.values()];
  }

  // goal과 무관한 필드는 덜어낸다 (트래픽이 아니면 impr/click, 앱설치가 아니면 install).
  function trimForGoal(row) {
    const out = { ...row };
    if (row.goal !== "트래픽") { delete out.impr; delete out.click; }
    if (row.goal !== "앱설치") delete out.install;
    return out;
  }

  // "summary" is a per-brand-per-promo breakdown (many rows) - asking the model to
  // mentally add up dozens of those rows to answer an aggregate question ("총 첫구매
  // 몇 건이야") is exactly the kind of arithmetic LLMs get wrong (observed live: it
  // answered a totals question with numbers that don't match any real slice of the
  // data). Pre-computing the per-goal-per-period totals here means the answer to any
  // "총/전체/합계" question is a lookup, not mental math over a long list.
  function computeQaTotals(scopedGroups, goals) {
    const totals = {};
    for (const goal of goals) {
      const periodA = scopedGroups.filter(g => g.goal === goal && g.period === "A");
      const periodB = scopedGroups.filter(g => g.goal === goal && g.period === "B");
      totals[goal] = {
        spendA: sum(periodA, "spend"), spendB: sum(periodB, "spend"),
        gmvA: sum(periodA, "gmv"), gmvB: sum(periodB, "gmv"),
        firstPurchaseA: sum(periodA, "firstPurchase"), firstPurchaseB: sum(periodB, "firstPurchase"),
        signupA: sum(periodA, "signup"), signupB: sum(periodB, "signup"),
        installA: sum(periodA, "install"), installB: sum(periodB, "install"),
      };
    }
    return totals;
  }

  function buildQaScopedData(question) {
    const { goals, wantsMaterial, wantsMediaDetail } = detectQaScope(question, qaContext.groups);
    const scopedGroups = qaContext.groups.filter(g => goals.includes(g.goal));
    const data = {
      totals: computeQaTotals(scopedGroups, goals),
      summary: qaGroupByPeriodPromo(scopedGroups).map(trimForGoal),
    };
    if (wantsMediaDetail) data.detailGroups = scopedGroups.map(trimForGoal);
    if (wantsMaterial) data.promoGroups = qaContext.promoGroups.filter(p => goals.includes(p.goal));
    return data;
  }

  function qaBubbleHtml(role, text) {
    return `<div class="qa-bubble ${role}">${esc(text).replace(/\n/g, "<br>")}</div>`;
  }

  // Optional data table attached below an AI answer (e.g. a multi-campaign comparison) -
  // null/empty most of the time, since only comparison-style questions get one.
  function qaTableHtml(table) {
    if (!table || !table.columns || !table.columns.length || !table.rows || !table.rows.length) return "";
    const head = `<tr>${table.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr>`;
    const body = table.rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("");
    return `<div class="qa-table-wrap"><table class="qa-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  function resetQaPanel() {
    qaHistory = [];
    qaCacheName = null;
    const historyEl = document.getElementById("qaHistory");
    if (historyEl) historyEl.innerHTML = "";
  }

  async function submitQaQuestion(question) {
    const historyEl = document.getElementById("qaHistory");
    const sendBtn = document.getElementById("qaSendBtn");
    if (!historyEl || !qaContext) return;

    historyEl.insertAdjacentHTML("beforeend", qaBubbleHtml("user", question));
    const loadingId = `qa-pending-${qaHistory.length}`;
    historyEl.insertAdjacentHTML("beforeend", `<div class="qa-bubble model qa-loading-bubble" id="${loadingId}">답변 생성 중...</div>`);
    historyEl.scrollTop = historyEl.scrollHeight;
    sendBtn.disabled = true;

    const priorHistory = qaHistory.slice();
    const body = {
      tab: qaContext.tab, weekLabels: qaContext.weekLabels,
      history: priorHistory, question,
      scopedData: buildQaScopedData(question),
    };
    if (qaCacheName) {
      body.cacheName = qaCacheName;
    } else if (priorHistory.length > 0) {
      // 2번째 질문(캐시가 아직 없는 후속 턴)에서만 전체 원본을 한 번 실어 보내 서버가
      // 캐시를 만들 재료로 쓰게 한다 - 그 이후로는 cacheName만 재사용.
      body.fullData = { groups: qaContext.groups, promoGroups: qaContext.promoGroups };
    }

    try {
      const res = await fetch("/api/qa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const resBody = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(resBody.error || `HTTP ${res.status}`);
      const answer = resBody.answer || "(빈 응답)";
      qaCacheName = resBody.cacheName || null;
      qaHistory.push({ role: "user", content: question }, { role: "model", content: answer });
      const bubble = document.getElementById(loadingId);
      if (bubble) { bubble.classList.remove("qa-loading-bubble"); bubble.innerHTML = esc(answer).replace(/\n/g, "<br>") + qaTableHtml(resBody.table); }
    } catch (err) {
      const bubble = document.getElementById(loadingId);
      const msg = String((err && err.message) || err);
      if (bubble) { bubble.classList.remove("qa-loading-bubble"); bubble.classList.add("qa-error-bubble"); bubble.textContent = `답변을 가져오지 못했습니다. (${msg})`; }
    } finally {
      sendBtn.disabled = false;
      historyEl.scrollTop = historyEl.scrollHeight;
    }
  }

  // ---------- notes (localStorage, keyed by B-week label) ----------
  const noteKeyFor = (weekBLabel) => `note:${weekBLabel}`;
  function loadNoteForWeek(weekBLabel) {
    const notesEl = document.getElementById("weekNote");
    if (!notesEl) return;
    notesEl.value = localStorage.getItem(noteKeyFor(weekBLabel)) || "";
  }
  function saveNoteForWeek(weekBLabel, text) {
    localStorage.setItem(noteKeyFor(weekBLabel), text);
  }

  // ---------- view mode (weekly report / monthly review) ----------
  let viewMode = "weekly"; // 'weekly' | 'monthly' - NOT the same thing as tabSelect's month "탭"s
  let monthlyState = null; // {tabA, tabB, labelA, labelB, rangeA, rangeB, groupsA/B, campaignGroupsA/B, promoGroupsARaw/BRaw}

  const viewModeWeeklyBtn = document.getElementById("viewModeWeeklyBtn");
  const viewModeMonthlyBtn = document.getElementById("viewModeMonthlyBtn");
  const weeklyRail = document.getElementById("weeklyRail");
  const monthlyRail = document.getElementById("monthlyRail");
  const weeklyMain = document.getElementById("weeklyMain");
  const monthlyMain = document.getElementById("monthlyMain");
  const monthASelect = document.getElementById("monthASelect");
  const monthBSelect = document.getElementById("monthBSelect");
  const monthlyRunBtn = document.getElementById("monthlyRunBtn");
  const monthlyIdleState = document.getElementById("monthlyIdleState");
  const monthlyReportState = document.getElementById("monthlyReportState");
  const monthlySectionsEl = document.getElementById("monthlySections");

  function setViewMode(mode) {
    viewMode = mode;
    viewModeWeeklyBtn.classList.toggle("active", mode === "weekly");
    viewModeWeeklyBtn.setAttribute("aria-selected", String(mode === "weekly"));
    viewModeMonthlyBtn.classList.toggle("active", mode === "monthly");
    viewModeMonthlyBtn.setAttribute("aria-selected", String(mode === "monthly"));
    weeklyRail.style.display = mode === "weekly" ? "" : "none";
    monthlyRail.style.display = mode === "monthly" ? "" : "none";
    weeklyMain.style.display = mode === "weekly" ? "" : "none";
    monthlyMain.style.display = mode === "monthly" ? "" : "none";
  }

  function populateMonthSelects() {
    const tabs = Object.keys(DATA.tabs).sort();
    const opts = tabs.map(t => `<option value="${esc(t)}">${esc(monthTabLabel(t))}</option>`).join("");
    const prevA = monthASelect.value, prevB = monthBSelect.value;
    monthASelect.innerHTML = opts;
    monthBSelect.innerHTML = opts;
    if (tabs.includes(prevA)) monthASelect.value = prevA;
    else if (tabs.length >= 2) monthASelect.value = tabs[tabs.length - 2];
    else if (tabs.length) monthASelect.value = tabs[0];
    if (tabs.includes(prevB)) monthBSelect.value = prevB;
    else if (tabs.length) monthBSelect.value = tabs[tabs.length - 1];
    monthlyRunBtn.disabled = !tabs.length;
  }

  // Prepares the A/B month data pool that sections 3-6 render from.
  function runMonthlyAnalysis() {
    const tabA = monthASelect.value, tabB = monthBSelect.value;
    if (!tabA || !tabB) { alert("비교할 두 달을 선택하세요."); return; }
    const rangeA = monthTabDateRange(tabA), rangeB = monthTabDateRange(tabB);
    const dataA = DATA.tabs[tabA] || {}, dataB = DATA.tabs[tabB] || {};

    monthlyState = {
      tabA, tabB, rangeA, rangeB, labelA: monthTabLabel(tabA), labelB: monthTabLabel(tabB),
      groupsA: aggregateGroupsByDateRange(dataA.groups || [], rangeA.start, rangeA.end),
      groupsB: aggregateGroupsByDateRange(dataB.groups || [], rangeB.start, rangeB.end),
      // day-level, NOT aggregated across dates - section 4's weekly GMV/ROAS chart and
      // media share need each row kept separate, unlike groupsA/B above.
      groupsARaw: (dataA.groups || []).filter(g => g.date >= rangeA.start && g.date <= rangeA.end),
      groupsBRaw: (dataB.groups || []).filter(g => g.date >= rangeB.start && g.date <= rangeB.end),
      // export_agg.py's per-tab week list (already chronologically sorted) - section 4's
      // weekly chart buckets by this same "주차" convention, not a generic Mon-Sun week.
      weeksA: dataA.weeks || [], weeksB: dataB.weeks || [],
      campaignGroupsA: aggregateCampaignGroupsByDateRange(dataA.campaignGroups || [], rangeA.start, rangeA.end),
      campaignGroupsB: aggregateCampaignGroupsByDateRange(dataB.campaignGroups || [], rangeB.start, rangeB.end),
      promoGroupsARaw: (dataA.promoGroups || []).filter(p => p.date >= rangeA.start && p.date <= rangeA.end),
      promoGroupsBRaw: (dataB.promoGroups || []).filter(p => p.date >= rangeB.start && p.date <= rangeB.end),
    };

    document.getElementById("monthlyLabelA").textContent = monthlyState.labelA;
    document.getElementById("monthlyLabelB").textContent = monthlyState.labelB;
    monthlyIdleState.style.display = "none";
    monthlyReportState.style.display = "block";
    monthlySectionsEl.innerHTML = buildSettingDiffSection(monthlyState) + buildPromoAnalysisSection(monthlyState);
  }

  // ---------- section 3: 이달 캠페인 세팅 변화 (campaign/group setting diff) ----------
  let settingDiffState = null; // {newCards, endedCards} - card index -> card, read back when gathering checked selections
  let settingDiffChat = null; // {items, history:[{role,content}]} for the follow-up mini chat, null until a comment is generated

  function settingDiffKeyOf(g) { return `${g.media}||${g.campaign}||${g.group}`; }
  function settingDiffCampaignKeyOf(g) { return `${g.media}||${g.campaign}`; }
  function settingDiffCardSpend(card) { return card.groups.reduce((s, g) => s + (g.spend || 0), 0); }

  // K_KPF(카카오 플러스친구)/Google AC/Google ACe rotate in a brand-new ad group
  // every week by design, so every monthly diff would otherwise be dominated by
  // dozens of "new/ended group" cards from these three alone that carry no real
  // setting-change signal. Filtered by rawMedia (raw "매체" column B) since it's
  // the only field that still distinguishes them - the canonical "media" field
  // they collapse into (Kakaomoment/Google) is shared with real, meaningful campaigns.
  const SETTING_DIFF_EXCLUDED_RAW_MEDIA = ["K_KPF", "Google AC", "Google ACe"];

  // B-only combos -> "신규 추가", A-only combos -> "그룹 종료", both grouped by
  // (media, campaign) so a campaign with several new/ended groups gets one card,
  // not one per group. isNewCampaign/isEndedCampaign flags whether the WHOLE
  // campaign is new/gone, not just some of its groups.
  function computeCampaignSettingDiff(campaignGroupsA, campaignGroupsB) {
    const keep = g => !SETTING_DIFF_EXCLUDED_RAW_MEDIA.includes(g.rawMedia);
    campaignGroupsA = campaignGroupsA.filter(keep);
    campaignGroupsB = campaignGroupsB.filter(keep);
    const mapA = new Map(campaignGroupsA.map(g => [settingDiffKeyOf(g), g]));
    const mapB = new Map(campaignGroupsB.map(g => [settingDiffKeyOf(g), g]));
    const campaignsInA = new Set(campaignGroupsA.map(settingDiffCampaignKeyOf));
    const campaignsInB = new Set(campaignGroupsB.map(settingDiffCampaignKeyOf));

    const newByCampaign = new Map();
    for (const g of campaignGroupsB) {
      if (mapA.has(settingDiffKeyOf(g))) continue;
      const ck = settingDiffCampaignKeyOf(g);
      if (!newByCampaign.has(ck)) newByCampaign.set(ck, { media: g.media, campaign: g.campaign, isNewCampaign: !campaignsInA.has(ck), groups: [] });
      newByCampaign.get(ck).groups.push(g);
    }
    const endedByCampaign = new Map();
    for (const g of campaignGroupsA) {
      if (mapB.has(settingDiffKeyOf(g))) continue;
      const ck = settingDiffCampaignKeyOf(g);
      if (!endedByCampaign.has(ck)) endedByCampaign.set(ck, { media: g.media, campaign: g.campaign, isEndedCampaign: !campaignsInB.has(ck), groups: [] });
      endedByCampaign.get(ck).groups.push(g);
    }
    return {
      newCards: [...newByCampaign.values()].sort((a, b) => settingDiffCardSpend(b) - settingDiffCardSpend(a)),
      endedCards: [...endedByCampaign.values()].sort((a, b) => settingDiffCardSpend(b) - settingDiffCardSpend(a)),
    };
  }

  // Raw (unformatted) aggregate across a card's groups - the shared source both the
  // card's displayed KPI snippet and the chart-building step compute from.
  function settingDiffCardAgg(card) {
    return card.groups.reduce((acc, g) => {
      acc.spend += g.spend || 0; acc.gmv += g.gmv || 0; acc.impr += g.impr || 0; acc.click += g.click || 0;
      acc.firstPurchase += g.firstPurchase || 0; acc.signup += g.signup || 0;
      acc.install += g.install || 0; acc.purchaseConv += g.purchaseConv || 0;
      return acc;
    }, { spend: 0, gmv: 0, impr: 0, click: 0, firstPurchase: 0, signup: 0, install: 0, purchaseConv: 0 });
  }

  // Which KPI set to show depends on the campaign's goal - reused for both the
  // card's displayed snippet and the AI comment payload, so the AI is handed the
  // exact same already-rounded values a person reads on screen (never raw counters
  // to divide itself - same "precompute, don't make the model do math" convention
  // used everywhere else in this codebase, e.g. Q&A's totals/roundForPrompt).
  function settingDiffKpiSet(goal, agg) {
    if (goal === "신규가입") return [
      { label: "첫구매수", value: fmtCount(agg.firstPurchase) },
      { label: "첫구매CPA", value: agg.firstPurchase > 0 ? fmtWon(agg.spend / agg.firstPurchase) : "-" },
      { label: "회원가입수", value: fmtCount(agg.signup) },
      { label: "회원가입CPA", value: agg.signup > 0 ? fmtWon(agg.spend / agg.signup) : "-" },
    ];
    if (goal === "트래픽") return [
      { label: "클릭수", value: fmtCount(agg.click) },
      { label: "CTR", value: agg.impr > 0 ? fmtPct2(ctr_(agg.click, agg.impr)) : "-" },
      { label: "CPC", value: agg.click > 0 ? fmtWon(cpc_(agg.spend, agg.click)) : "-" },
    ];
    if (goal === "앱설치") return [
      { label: "앱설치수", value: fmtCount(agg.install) },
      { label: "CPI", value: agg.install > 0 ? fmtWon(cpi_(agg.spend, agg.install)) : "-" },
    ];
    return [ // 매출 (기본값)
      { label: "구매수", value: fmtCount(agg.purchaseConv) },
      { label: "GMV", value: fmtWonAbbrev(agg.gmv) },
      { label: "ROAS", value: agg.spend > 0 ? fmtPct(roas(agg.gmv, agg.spend)) : "-" },
      { label: "CVR", value: agg.click > 0 ? fmtPct2(agg.purchaseConv / agg.click * 100) : "-" },
    ];
  }

  function settingDiffCardHtml(card, kind, idx) {
    const goal = (card.groups[0] || {}).goal || "";
    const agg = settingDiffCardAgg(card);
    const kpiText = settingDiffKpiSet(goal, agg).map(k => `${k.label} ${k.value}`).join(" · ");
    const campaignTag = kind === "new"
      ? (card.isNewCampaign ? `<span class="status-chip">신규 캠페인</span>` : "")
      : (card.isEndedCampaign ? `<span class="status-chip">캠페인 종료</span>` : "");
    const groupChips = card.groups.map(g => `<code>${esc(g.group)}</code>`).join(" ");
    return `<label class="diff-card">
      <input type="checkbox" class="diff-checkbox" data-kind="${kind}" data-idx="${idx}">
      <div class="diff-card-body">
        <div class="diff-card-head"><b>${esc(card.media)} · ${esc(card.campaign)}</b>${campaignTag}</div>
        <div class="diff-card-groups">${groupChips}</div>
        <div class="diff-card-perf">지출 ${fmtWon(agg.spend)} · ${kpiText}</div>
      </div>
    </label>`;
  }

  function buildSettingDiffSection(state) {
    const { newCards, endedCards } = computeCampaignSettingDiff(state.campaignGroupsA, state.campaignGroupsB);
    settingDiffState = { newCards, endedCards };
    settingDiffChat = null;

    const newHtml = newCards.length
      ? newCards.map((c, i) => settingDiffCardHtml(c, "new", i)).join("")
      : `<p class="empty-note">신규 추가된 캠페인/그룹이 없습니다.</p>`;
    const endedHtml = endedCards.length
      ? endedCards.map((c, i) => settingDiffCardHtml(c, "ended", i)).join("")
      : `<p class="empty-note">종료된 캠페인/그룹이 없습니다.</p>`;

    return `<section class="section-card" data-ch="SETTING_DIFF">
      <div class="section-title"><span class="tag">SETTING</span><h3>이달 캠페인 세팅 변화</h3></div>
      <p class="subhead">신규 추가</p>
      <div class="diff-card-list">${newHtml}</div>
      <p class="subhead">그룹 종료</p>
      <div class="diff-card-list">${endedHtml}</div>
      <div class="diff-actions">
        <button type="button" class="run-btn" id="settingDiffCommentBtn" disabled>선택한 변화 코멘트 생성</button>
      </div>
      <div id="settingDiffCommentBody"></div>
    </section>`;
  }

  // items carry BOTH a `raw` numeric aggregate (chart-building, client-only) and
  // pre-formatted `spend`/`kpis` strings (sent to the AI) - stripped of `raw` right
  // before the POST body is built, so the model only ever sees ready-to-cite values.
  function gatherSelectedDiffItems() {
    if (!settingDiffState) return [];
    return [...document.querySelectorAll(".diff-checkbox:checked")].map(cb => {
      const kind = cb.dataset.kind;
      const card = (kind === "new" ? settingDiffState.newCards : settingDiffState.endedCards)[Number(cb.dataset.idx)];
      const goal = (card.groups[0] || {}).goal || "";
      const raw = settingDiffCardAgg(card);
      const kpis = {};
      for (const k of settingDiffKpiSet(goal, raw)) kpis[k.label] = k.value;
      return {
        kind, media: card.media, campaign: card.campaign, goal,
        isNewCampaign: !!card.isNewCampaign, isEndedCampaign: !!card.isEndedCampaign,
        groupNames: card.groups.map(g => g.group),
        spend: fmtWon(raw.spend), kpis, raw,
      };
    });
  }

  async function generateSettingDiffComment() {
    const items = gatherSelectedDiffItems();
    if (!items.length) return;
    const btn = document.getElementById("settingDiffCommentBtn");
    const bodyEl = document.getElementById("settingDiffCommentBody");
    btn.disabled = true;
    bodyEl.innerHTML = commentLoadingHtml();
    const itemsForApi = items.map(({ raw, ...rest }) => rest);
    try {
      const res = await fetch("/api/monthly-comment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthALabel: monthlyState.labelA, monthBLabel: monthlyState.labelB, items: itemsForApi }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      settingDiffChat = { items: itemsForApi, history: [{ role: "model", content: body.text }] };
      bodyEl.innerHTML = settingDiffCommentHtml(body.text);
      renderSettingDiffPerfTable(items);
    } catch (err) {
      bodyEl.innerHTML = `<p class="ai-error">AI 코멘트를 가져오지 못했습니다. (${esc(String((err && err.message) || err))})</p>`;
    } finally {
      btn.disabled = false;
    }
  }

  // Shared by every monthly-review "코멘트 + 후속 질문" block (section 3's setting-diff,
  // section 4's promo analysis) - idPrefix keeps each instance's element ids distinct.
  function inlineFollowupHtml(idPrefix, placeholder) {
    return `
      <button type="button" class="retry-btn" id="${idPrefix}Toggle">이 코멘트에 대해 더 물어보기</button>
      <div id="${idPrefix}Panel" class="inline-chat" style="display:none;">
        <div id="${idPrefix}History" class="inline-chat-history"></div>
        <form id="${idPrefix}Form" class="inline-chat-form">
          <textarea id="${idPrefix}Input" rows="2" placeholder="${esc(placeholder)}"></textarea>
          <button type="submit" class="qa-send-btn">전송</button>
        </form>
      </div>`;
  }

  function settingDiffCommentHtml(text) {
    return `
      <div class="comment"><p>${esc(text).replace(/\n/g, "<br>")}</p></div>
      <div id="settingDiffPerfTable"></div>
      ${inlineFollowupHtml("settingDiffFollowup", "예: 이 중 지출이 가장 큰 신규 캠페인은?")}`;
  }

  // One performance table per goal present among the selected items ("유연성 있게" -
  // the columns adapt to whichever goal(s) the comment covers), reusing each item's
  // already-computed `kpis` object directly instead of recomputing anything.
  function renderSettingDiffPerfTable(items) {
    const container = document.getElementById("settingDiffPerfTable");
    if (!container) return;
    const byGoal = new Map();
    for (const it of items) {
      if (!byGoal.has(it.goal)) byGoal.set(it.goal, []);
      byGoal.get(it.goal).push(it);
    }
    container.innerHTML = [...byGoal.entries()].map(([goal, goalItems]) => {
      const kpiLabels = Object.keys(goalItems[0].kpis);
      const head = `<tr><th>매체 · 캠페인</th><th>지출</th>${kpiLabels.map(l => `<th>${esc(l)}</th>`).join("")}</tr>`;
      const rows = goalItems.map(it => `<tr>
        <td>${esc(it.media)} · ${esc(it.campaign)}</td>
        <td>${esc(it.spend)}</td>
        ${kpiLabels.map(l => `<td>${esc(it.kpis[l])}</td>`).join("")}
      </tr>`).join("");
      return `<div class="perf-table-block">
        <p class="subhead">${esc(goal)} 지표</p>
        <div class="table-wrap"><table class="detail-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
      </div>`;
    }).join("");
  }

  // The initial comment only ever sees the checked cards - fine for "analyze what I
  // picked", but a follow-up like "다른 캠페인이랑 비교하면?" or "X 캠페인 있어?" needs
  // more than that. Widened here (not on the initial call) to the full month's raw
  // campaignGroups rows for whichever media the checked items belong to, so sibling
  // campaigns under the same media - selected or not, changed or not - are answerable.
  function settingDiffMediaContext() {
    if (!settingDiffChat || !monthlyState) return [];
    const relatedMedia = new Set(settingDiffChat.items.map(it => it.media));
    const rowsA = monthlyState.campaignGroupsA.map(g => ({ ...g, period: monthlyState.labelA }));
    const rowsB = monthlyState.campaignGroupsB.map(g => ({ ...g, period: monthlyState.labelB }));
    return [...rowsA, ...rowsB]
      .filter(g => relatedMedia.has(g.media) && !SETTING_DIFF_EXCLUDED_RAW_MEDIA.includes(g.rawMedia))
      .map(g => ({
        period: g.period, media: g.media, campaign: g.campaign, group: g.group, goal: g.goal,
        spend: Math.round(g.spend), gmv: Math.round(g.gmv), impr: Math.round(g.impr), click: Math.round(g.click),
        firstPurchase: Math.round(g.firstPurchase), signup: Math.round(g.signup),
        install: Math.round(g.install), purchaseConv: Math.round(g.purchaseConv),
      }));
  }

  async function submitSettingDiffFollowup(question) {
    if (!settingDiffChat) return;
    const historyEl = document.getElementById("settingDiffFollowupHistory");
    historyEl.insertAdjacentHTML("beforeend", `<div class="qa-bubble user">${esc(question)}</div>`);
    settingDiffChat.history.push({ role: "user", content: question });
    const loadingId = "sdf-loading-" + Math.random().toString(36).slice(2);
    historyEl.insertAdjacentHTML("beforeend", `<div class="qa-bubble model qa-loading-bubble" id="${loadingId}">답변 생성 중...</div>`);
    historyEl.scrollTop = historyEl.scrollHeight;
    try {
      const res = await fetch("/api/monthly-comment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          monthALabel: monthlyState.labelA, monthBLabel: monthlyState.labelB,
          items: settingDiffChat.items, question, history: settingDiffChat.history.slice(0, -1),
          mediaContext: settingDiffMediaContext(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      document.getElementById(loadingId).outerHTML = `<div class="qa-bubble model">${esc(body.text).replace(/\n/g, "<br>")}</div>`;
      settingDiffChat.history.push({ role: "model", content: body.text });
    } catch (err) {
      document.getElementById(loadingId).outerHTML = `<div class="qa-bubble model qa-error-bubble">답변을 가져오지 못했습니다. (${esc(String((err && err.message) || err))})</div>`;
    }
  }

  // ---------- section 4: 특정 기획전 성과 분석 (search + weekly metric-picker chart + media donut + compare table) ----------
  let promoAnalysisState = null; // {rowsA, rowsB, weeksA, weeksB, searchIndex}
  let promoSelections = []; // [{id, brand, promo}], in selection order
  let promoSelectionSeq = 0; // monotonic - stays stable across re-renders even if an earlier selection is removed
  let promoBlockState = {}; // id -> {weeklyA, weeklyB, chartMetrics:{bar,line}, donutMetric, mediaShare, chat, chartInstances}

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Selectable metrics for the weekly chart's bar/line axes - both dropdowns share
  // this same pool, so either axis can show any of the 10.
  const PROMO_METRIC_OPTIONS = [
    { key: "gmv", label: "GMV", fmt: fmtWonAbbrev },
    { key: "roas", label: "ROAS", fmt: fmtPct },
    { key: "cvr", label: "CVR", fmt: fmtPct2 },
    { key: "ctr", label: "CTR", fmt: fmtPct2 },
    { key: "cpc", label: "CPC", fmt: fmtWon },
    { key: "cpi", label: "CPI", fmt: fmtWon },
    { key: "firstPurchase", label: "첫구매수", fmt: fmtCount },
    { key: "firstPurchaseCpa", label: "첫구매CPA", fmt: fmtWon },
    { key: "signup", label: "회원가입수", fmt: fmtCount },
    { key: "signupCpa", label: "회원가입CPA", fmt: fmtWon },
  ];
  // Selectable metrics for the media-share donut - "지출" stays the default (matches
  // the section's original behavior) with 6 more added alongside it.
  const PROMO_DONUT_METRICS = [
    { key: "spend", label: "지출", fmt: fmtWon },
    { key: "gmv", label: "GMV", fmt: fmtWon },
    { key: "firstPurchase", label: "첫구매수", fmt: fmtCount },
    { key: "signup", label: "회원가입수", fmt: fmtCount },
    { key: "install", label: "앱설치수", fmt: fmtCount },
    { key: "click", label: "클릭수", fmt: fmtCount },
    { key: "impr", label: "노출수", fmt: fmtCount },
  ];

  // brand+promo, not promo alone - the same promo name can exist under different
  // brands (an existing rule in this codebase, e.g. the weekly AI comment's
  // "브랜드가 다르면 기획전명이 같아도 서로 다른 캠페인" instruction), so search
  // results and selection both key on the pair to avoid picking the wrong one.
  function buildPromoSearchIndex(rowsA, rowsB) {
    const seen = new Map();
    for (const g of [...rowsA, ...rowsB]) {
      if (!g.promo) continue;
      const key = `${g.brand}||${g.promo}`;
      if (!seen.has(key)) seen.set(key, { brand: g.brand, promo: g.promo });
    }
    return [...seen.values()].sort((a, b) => a.promo.localeCompare(b.promo, "ko"));
  }

  function buildPromoAnalysisSection(state) {
    promoAnalysisState = {
      rowsA: state.groupsARaw, rowsB: state.groupsBRaw, weeksA: state.weeksA, weeksB: state.weeksB,
      searchIndex: buildPromoSearchIndex(state.groupsARaw, state.groupsBRaw),
    };
    promoSelections = [];
    promoSelectionSeq = 0;
    promoBlockState = {};
    return `<section class="section-card" data-ch="PROMO">
      <div class="section-title"><span class="tag">PROMO</span><h3>특정 기획전 성과 분석</h3></div>
      <div class="field promo-search-field">
        <input type="text" id="promoSearchInput" placeholder="기획전명 또는 브랜드명을 입력하세요 (예: 1만원이상_시즌, 헤라) - 여러 개 선택 가능" autocomplete="off">
        <div id="promoSearchResults" class="promo-search-results" style="display:none;"></div>
      </div>
      <div id="promoSelectedChips" class="promo-chip-row"></div>
      <div id="promoAnalysisBody"><p class="empty-note">기획전을 검색해서 선택하면 분석이 표시됩니다. 여러 개를 선택할 수 있습니다.</p></div>
    </section>`;
  }

  function renderPromoSearchResults(query) {
    const resultsEl = document.getElementById("promoSearchResults");
    if (!resultsEl || !promoAnalysisState) return;
    const q = query.trim().toLowerCase();
    if (!q) { resultsEl.style.display = "none"; resultsEl.innerHTML = ""; return; }
    const matches = promoAnalysisState.searchIndex
      .filter(p => p.promo.toLowerCase().includes(q) || (p.brand && p.brand.toLowerCase().includes(q)))
      .slice(0, 20);
    resultsEl.innerHTML = matches.length
      ? matches.map(p => `<div class="promo-search-item" data-brand="${esc(p.brand)}" data-promo="${esc(p.promo)}">${esc(p.brand)} · ${esc(p.promo)}</div>`).join("")
      : `<div class="promo-search-item promo-search-empty">일치하는 기획전/브랜드가 없습니다.</div>`;
    resultsEl.style.display = "block";
  }

  function addPromoSelection(brand, promo) {
    if (!promoSelections.some(p => p.brand === brand && p.promo === promo)) {
      promoSelections.push({ id: promoSelectionSeq++, brand, promo });
      renderPromoAnalysisList();
    }
    const input = document.getElementById("promoSearchInput");
    const results = document.getElementById("promoSearchResults");
    if (input) input.value = "";
    if (results) results.style.display = "none";
  }

  function removePromoSelection(id) {
    const st = promoBlockState[id];
    if (st) st.chartInstances.forEach(c => c.destroy());
    delete promoBlockState[id];
    promoSelections = promoSelections.filter(p => p.id !== id);
    renderPromoAnalysisList();
  }

  // Buckets by the sheet's own "주차" convention (weekLabel), not a generic Mon-Sun
  // week, matching how the rest of this dashboard already talks about weeks. Every
  // week in weeksMeta gets a row (0-filled when the promo had no activity that week)
  // so gaps/start/end still show, same reasoning the old daily fill used.
  function buildWeeklySeries(rows, weeksMeta, brand, promo) {
    const byWeek = new Map();
    for (const w of weeksMeta) {
      byWeek.set(w.label, { label: w.label, start: w.start, end: w.end, spend: 0, gmv: 0, impr: 0, click: 0, firstPurchase: 0, signup: 0, install: 0, purchaseConv: 0 });
    }
    for (const g of rows) {
      if (g.brand !== brand || g.promo !== promo) continue;
      const bucket = byWeek.get(g.weekLabel);
      if (!bucket) continue;
      bucket.spend += g.spend || 0; bucket.gmv += g.gmv || 0; bucket.impr += g.impr || 0; bucket.click += g.click || 0;
      bucket.firstPurchase += g.firstPurchase || 0; bucket.signup += g.signup || 0;
      bucket.install += g.install || 0; bucket.purchaseConv += g.purchaseConv || 0;
    }
    return [...byWeek.values()];
  }

  // All 10 PROMO_METRIC_OPTIONS values for one week bucket, precomputed once so
  // switching the bar/line dropdown never re-derives anything from raw sums again.
  function computePromoWeekMetrics(w) {
    return {
      gmv: Math.round(w.gmv),
      roas: w.spend > 0 ? Math.round(roas(w.gmv, w.spend)) : null,
      cvr: w.click > 0 ? Math.round((w.purchaseConv / w.click * 100) * 100) / 100 : null,
      ctr: w.impr > 0 ? Math.round(ctr_(w.click, w.impr) * 100) / 100 : null,
      cpc: w.click > 0 ? Math.round(cpc_(w.spend, w.click)) : null,
      cpi: w.install > 0 ? Math.round(cpi_(w.spend, w.install)) : null,
      firstPurchase: Math.round(w.firstPurchase),
      firstPurchaseCpa: w.firstPurchase > 0 ? Math.round(w.spend / w.firstPurchase) : null,
      signup: Math.round(w.signup),
      signupCpa: w.signup > 0 ? Math.round(w.spend / w.signup) : null,
    };
  }

  function computePromoMediaShare(rowsA, rowsB, brand, promo, metricKey) {
    metricKey = metricKey || "spend";
    const matched = [...rowsA, ...rowsB].filter(g => g.brand === brand && g.promo === promo);
    const byMedia = groupByMedia(matched);
    const total = byMedia.reduce((s, m) => s + (m[metricKey] || 0), 0);
    return byMedia.filter(m => (m[metricKey] || 0) > 0).sort((a, b) => b[metricKey] - a[metricKey])
      .map(m => ({ media: m.media, value: m[metricKey], pct: total > 0 ? (m[metricKey] / total * 100) : 0 }));
  }

  function sumWeeklyTotals(weekArr) {
    return weekArr.reduce((acc, w) => ({
      spend: acc.spend + w.spend, gmv: acc.gmv + w.gmv,
      firstPurchase: acc.firstPurchase + w.firstPurchase, signup: acc.signup + w.signup,
    }), { spend: 0, gmv: 0, firstPurchase: 0, signup: 0 });
  }

  function promoBlockHtml(p) {
    const st = promoBlockState[p.id];
    const metricOptionsHtml = (selectedKey) => PROMO_METRIC_OPTIONS.map(m => `<option value="${m.key}"${m.key === selectedKey ? " selected" : ""}>${esc(m.label)}</option>`).join("");
    const donutOptionsHtml = PROMO_DONUT_METRICS.map(m => `<option value="${m.key}"${m.key === st.donutMetric ? " selected" : ""}>${esc(m.label)}</option>`).join("");
    return `<div class="promo-analysis-block" data-promo-id="${p.id}">
      <div class="promo-analysis-head"><b>${esc(p.brand)} · ${esc(p.promo)}</b></div>
      <div class="promo-charts-grid">
        <div class="chart-block">
          <div class="chart-controls">
            <p class="subhead">주별 추이</p>
            <select class="promo-metric-select top-metric-select" data-promo-id="${p.id}" data-axis="bar">${metricOptionsHtml(st.chartMetrics.bar)}</select>
            <select class="promo-metric-select top-metric-select" data-promo-id="${p.id}" data-axis="line">${metricOptionsHtml(st.chartMetrics.line)}</select>
          </div>
          <div class="chart-canvas-wrap"><canvas id="promoWeeklyChart-${p.id}"></canvas></div>
        </div>
        <div class="chart-block">
          <div class="chart-controls">
            <p class="subhead">매체별 비중</p>
            <select class="promo-donut-select top-metric-select" data-promo-id="${p.id}">${donutOptionsHtml}</select>
          </div>
          <div class="chart-canvas-wrap chart-canvas-wrap-donut"><canvas id="promoMediaChart-${p.id}"></canvas></div>
        </div>
      </div>
      <div class="diff-actions">
        <button type="button" class="run-btn" id="promoCommentBtn-${p.id}" data-promo-id="${p.id}">이 기획전 코멘트 생성</button>
      </div>
      <div id="promoCommentBody-${p.id}"></div>
    </div>`;
  }

  function buildPromoCompareTableHtml() {
    const rows = promoSelections.map(p => {
      const st = promoBlockState[p.id];
      if (!st) return null;
      return { p, totA: sumWeeklyTotals(st.weeklyA), totB: sumWeeklyTotals(st.weeklyB) };
    }).filter(Boolean);
    if (!rows.length) return "";

    const head = `<tr><th>기획전</th><th>지출</th><th>GMV</th><th>ROAS</th><th>첫구매수</th><th>첫구매CPA</th><th>회원가입수</th><th>회원가입CPA</th></tr>`;
    const bodyRows = rows.map(({ p, totA, totB }) => {
      const roasA = totA.spend > 0 ? roas(totA.gmv, totA.spend) : 0;
      const roasB = totB.spend > 0 ? roas(totB.gmv, totB.spend) : 0;
      const fpCpaCell = (totA.firstPurchase > 0 && totB.firstPurchase > 0)
        ? abCellHtml(totA.spend / totA.firstPurchase, totB.spend / totB.firstPurchase, fmtWon)
        : `<span class="cell-na">-</span>`;
      const suCpaCell = (totA.signup > 0 && totB.signup > 0)
        ? abCellHtml(totA.spend / totA.signup, totB.spend / totB.signup, fmtWon)
        : `<span class="cell-na">-</span>`;
      return `<tr>
        <td>${esc(p.brand)} · ${esc(p.promo)}</td>
        <td>${abCellHtml(totA.spend, totB.spend, fmtWon)}</td>
        <td>${abCellHtml(totA.gmv, totB.gmv, fmtWonAbbrev)}</td>
        <td>${abCellHtml(roasA, roasB, fmtPct)}</td>
        <td>${abCellHtml(totA.firstPurchase, totB.firstPurchase, fmtCount)}</td>
        <td>${fpCpaCell}</td>
        <td>${abCellHtml(totA.signup, totB.signup, fmtCount)}</td>
        <td>${suCpaCell}</td>
      </tr>`;
    }).join("");

    return `<div class="perf-table-block">
      <p class="subhead">기획전 비교</p>
      <div class="table-wrap"><table class="detail-table"><thead>${head}</thead><tbody>${bodyRows}</tbody></table></div>
    </div>`;
  }

  // Rebuilds the whole selected-promo list from scratch on every add/remove, but
  // SKIPS recompute for ids already in promoBlockState - otherwise adding a 2nd promo
  // would blow away the 1st promo's dropdown choices and any already-generated comment.
  function renderPromoAnalysisList() {
    const chipsEl = document.getElementById("promoSelectedChips");
    const bodyEl = document.getElementById("promoAnalysisBody");
    if (!chipsEl || !bodyEl || !promoAnalysisState) return;

    chipsEl.innerHTML = promoSelections.map(p => `<span class="promo-chip">${esc(p.brand)} · ${esc(p.promo)}<button type="button" class="promo-chip-remove" data-remove-id="${p.id}" aria-label="선택 해제">×</button></span>`).join("");

    if (!promoSelections.length) {
      bodyEl.innerHTML = `<p class="empty-note">기획전을 검색해서 선택하면 분석이 표시됩니다. 여러 개를 선택할 수 있습니다.</p>`;
      return;
    }

    const { rowsA, rowsB, weeksA, weeksB } = promoAnalysisState;
    for (const p of promoSelections) {
      if (promoBlockState[p.id]) continue;
      promoBlockState[p.id] = {
        weeklyA: buildWeeklySeries(rowsA, weeksA, p.brand, p.promo),
        weeklyB: buildWeeklySeries(rowsB, weeksB, p.brand, p.promo),
        chartMetrics: { bar: "gmv", line: "roas" }, donutMetric: "spend",
        mediaShare: computePromoMediaShare(rowsA, rowsB, p.brand, p.promo, "spend"),
        chat: null, chartInstances: [],
      };
    }

    bodyEl.innerHTML = (promoSelections.length >= 2 ? buildPromoCompareTableHtml() : "") + promoSelections.map(promoBlockHtml).join("");
    for (const p of promoSelections) {
      renderPromoCharts(p.id);
      renderPromoCommentArea(p.id);
    }
  }

  function renderPromoCharts(id) {
    const st = promoBlockState[id];
    if (!st) return;
    st.chartInstances.forEach(c => c.destroy());
    st.chartInstances = [];
    if (typeof Chart === "undefined") return;

    const ink = cssVar("--ink-soft") || "#6C6960";
    const accent = cssVar("--accent") || "#57524A";
    const border = cssVar("--border") || "#DDDAD2";
    const surface = cssVar("--surface") || "#FFFFFF";
    const donutPalette = ["--ink", "--accent", "--accent-2", "--accent-3", "--accent-4", "--ink-soft", "--border"]
      .map(v => cssVar(v)).filter(Boolean);
    Chart.defaults.color = ink;
    Chart.defaults.font.family = cssVar("--font-kr") || undefined;

    const weekly = [...st.weeklyA, ...st.weeklyB];
    const weeklyCanvas = document.getElementById(`promoWeeklyChart-${id}`);
    if (weeklyCanvas) {
      const perWeek = weekly.map(computePromoWeekMetrics);
      const barSpec = PROMO_METRIC_OPTIONS.find(m => m.key === st.chartMetrics.bar);
      const lineSpec = PROMO_METRIC_OPTIONS.find(m => m.key === st.chartMetrics.line);
      st.chartInstances.push(new Chart(weeklyCanvas.getContext("2d"), {
        data: {
          labels: weekly.map(w => w.label),
          datasets: [
            { type: "bar", label: barSpec.label, data: perWeek.map(m => m[barSpec.key]), backgroundColor: ink, borderRadius: 3, yAxisID: "yBar", order: 2 },
            { type: "line", label: lineSpec.label, data: perWeek.map(m => m[lineSpec.key]), borderColor: accent, backgroundColor: accent, pointBackgroundColor: accent, yAxisID: "yLine", tension: 0.25, spanGaps: true, order: 1, pointRadius: 3 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: ink } },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const spec = ctx.dataset.yAxisID === "yBar" ? barSpec : lineSpec;
                  const v = ctx.parsed.y;
                  return `${spec.label}: ${v == null ? "-" : spec.fmt(v)}`;
                },
              },
            },
          },
          scales: {
            x: { ticks: { color: ink, maxRotation: 60, minRotation: 30 }, grid: { display: false } },
            yBar: { position: "left", ticks: { color: ink }, grid: { color: border } },
            yLine: { position: "right", ticks: { color: ink }, grid: { display: false } },
          },
        },
      }));
    }

    const mediaCanvas = document.getElementById(`promoMediaChart-${id}`);
    if (mediaCanvas) {
      const donutSpec = PROMO_DONUT_METRICS.find(m => m.key === st.donutMetric);
      if (!st.mediaShare.length) {
        mediaCanvas.closest(".chart-canvas-wrap").innerHTML = `<p class="empty-note">데이터가 없습니다.</p>`;
      } else {
        st.chartInstances.push(new Chart(mediaCanvas.getContext("2d"), {
          type: "doughnut",
          data: {
            labels: st.mediaShare.map(m => m.media),
            datasets: [{
              data: st.mediaShare.map(m => m.value),
              backgroundColor: st.mediaShare.map((_, i) => donutPalette[i % donutPalette.length]),
              borderColor: surface, borderWidth: 2,
            }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { position: "bottom", labels: { color: ink, boxWidth: 12, font: { size: 11 } } },
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const m = st.mediaShare[ctx.dataIndex];
                    return `${m.media}: ${donutSpec.fmt(m.value)} (${m.pct.toFixed(1)}%)`;
                  },
                },
              },
            },
          },
        }));
      }
    }
  }

  function buildPromoCommentPayload(brand, promo, st) {
    const totA = sumWeeklyTotals(st.weeklyA), totB = sumWeeklyTotals(st.weeklyB);
    return {
      brand, promo,
      monthALabel: monthlyState.labelA, monthBLabel: monthlyState.labelB,
      totals: {
        spendA: Math.round(totA.spend), gmvA: Math.round(totA.gmv),
        roasA: totA.spend > 0 ? Math.round(roas(totA.gmv, totA.spend)) : null,
        spendB: Math.round(totB.spend), gmvB: Math.round(totB.gmv),
        roasB: totB.spend > 0 ? Math.round(roas(totB.gmv, totB.spend)) : null,
      },
      weeklySeries: [...st.weeklyA, ...st.weeklyB].map(w => ({
        week: w.label, spend: Math.round(w.spend), ...computePromoWeekMetrics(w),
      })),
      mediaShareMetric: PROMO_DONUT_METRICS.find(m => m.key === st.donutMetric).label,
      mediaShare: st.mediaShare.map(m => ({ media: m.media, value: Math.round(m.value), pct: Math.round(m.pct * 10) / 10 })),
    };
  }

  function renderPromoCommentArea(id) {
    const st = promoBlockState[id];
    const bodyEl = document.getElementById(`promoCommentBody-${id}`);
    if (!st || !bodyEl || !st.chat) return;
    bodyEl.innerHTML = `
      <div class="comment"><p>${esc(st.chat.history[0].content).replace(/\n/g, "<br>")}</p></div>
      ${inlineFollowupHtml(`promoFollowup${id}`, "예: 이 기획전의 매체별 성과 차이가 큰 이유는?")}`;
    const histEl = document.getElementById(`promoFollowup${id}History`);
    if (histEl && st.chat.history.length > 1) {
      histEl.innerHTML = st.chat.history.slice(1)
        .map(h => `<div class="qa-bubble ${h.role === "user" ? "user" : "model"}">${esc(h.content).replace(/\n/g, "<br>")}</div>`)
        .join("");
    }
  }

  async function generatePromoComment(id) {
    const st = promoBlockState[id];
    const sel = promoSelections.find(p => p.id === id);
    if (!st || !sel) return;
    const btn = document.getElementById(`promoCommentBtn-${id}`);
    const bodyEl = document.getElementById(`promoCommentBody-${id}`);
    btn.disabled = true;
    bodyEl.innerHTML = commentLoadingHtml();
    const payload = buildPromoCommentPayload(sel.brand, sel.promo, st);
    try {
      const res = await fetch("/api/monthly-promo-comment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      st.chat = { payload, history: [{ role: "model", content: body.text }] };
      renderPromoCommentArea(id);
    } catch (err) {
      bodyEl.innerHTML = `<p class="ai-error">AI 코멘트를 가져오지 못했습니다. (${esc(String((err && err.message) || err))})</p>`;
    } finally {
      btn.disabled = false;
    }
  }

  async function submitPromoFollowup(id, question) {
    const st = promoBlockState[id];
    if (!st || !st.chat) return;
    const historyEl = document.getElementById(`promoFollowup${id}History`);
    historyEl.insertAdjacentHTML("beforeend", `<div class="qa-bubble user">${esc(question)}</div>`);
    st.chat.history.push({ role: "user", content: question });
    const loadingId = `pf-loading-${id}-` + Math.random().toString(36).slice(2);
    historyEl.insertAdjacentHTML("beforeend", `<div class="qa-bubble model qa-loading-bubble" id="${loadingId}">답변 생성 중...</div>`);
    historyEl.scrollTop = historyEl.scrollHeight;
    try {
      const res = await fetch("/api/monthly-promo-comment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...st.chat.payload, question, history: st.chat.history.slice(0, -1) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      document.getElementById(loadingId).outerHTML = `<div class="qa-bubble model">${esc(body.text).replace(/\n/g, "<br>")}</div>`;
      st.chat.history.push({ role: "model", content: body.text });
    } catch (err) {
      document.getElementById(loadingId).outerHTML = `<div class="qa-bubble model qa-error-bubble">답변을 가져오지 못했습니다. (${esc(String((err && err.message) || err))})</div>`;
    }
  }

  // ---------- wiring ----------
  let DATA = null;
  let DATA_CURRENT = null; // merged raw day-level {groups, promoGroups} pool across every checked tab

  const tabSelect = document.getElementById("tabSelect");
  const dateAStart = document.getElementById("dateAStart");
  const dateAEnd = document.getElementById("dateAEnd");
  const dateBStart = document.getElementById("dateBStart");
  const dateBEnd = document.getElementById("dateBEnd");
  const dateOverlapWarning = document.getElementById("dateOverlapWarning");
  const shortcutRecentBtn = document.getElementById("shortcutRecent");
  const refreshDataBtn = document.getElementById("refreshDataBtn");
  const runBtn = document.getElementById("runBtn");
  const idleState = document.getElementById("idleState");
  const reportState = document.getElementById("reportState");
  const errorState = document.getElementById("errorState");
  const sectionsEl = document.getElementById("sections");
  const weekNoteEl = document.getElementById("weekNote");
  const qaPanel = document.getElementById("qaPanel");
  const qaToggleBtn = document.getElementById("qaToggleBtn");
  const qaCloseBtn = document.getElementById("qaCloseBtn");
  const qaForm = document.getElementById("qaForm");
  const qaInput = document.getElementById("qaInput");

  // Compare-toggle checkboxes, metric dropdowns, and the AI retry button are re-created
  // on every run, so wire them once via event delegation.
  sectionsEl.addEventListener("change", (e) => {
    if (e.target.classList.contains("compare-toggle")) {
      const suffix = e.target.dataset.target;
      const single = document.getElementById(`detail-single-${suffix}`);
      const compare = document.getElementById(`detail-compare-${suffix}`);
      if (!single || !compare) return;
      single.style.display = e.target.checked ? "none" : "block";
      compare.style.display = e.target.checked ? "block" : "none";
    } else if (e.target.classList.contains("detail-metric-select")) {
      const suffix = e.target.dataset.target;
      const st = detailBlockState[suffix];
      if (!st) return;
      st.metricKey = e.target.value;
      renderDetailSingle(suffix);
      renderDetailCompare(suffix);
    }
  });
  sectionsEl.addEventListener("click", (e) => {
    if (e.target.dataset.action === "retry-comments" && lastPromptPayload) {
      requestAIComments(lastPromptPayload);
    }
  });

  // 이달 캠페인 세팅 변화 (section 3) - re-created on every 월간 분석 run, so wired
  // once via delegation on the shared monthlySections container, same pattern as sectionsEl above.
  monthlySectionsEl.addEventListener("change", (e) => {
    if (e.target.classList.contains("diff-checkbox")) {
      const btn = document.getElementById("settingDiffCommentBtn");
      if (btn) btn.disabled = !document.querySelector(".diff-checkbox:checked");
    } else if (e.target.classList.contains("promo-metric-select")) {
      const id = Number(e.target.dataset.promoId);
      const st = promoBlockState[id];
      if (st) { st.chartMetrics[e.target.dataset.axis] = e.target.value; renderPromoCharts(id); }
    } else if (e.target.classList.contains("promo-donut-select")) {
      const id = Number(e.target.dataset.promoId);
      const st = promoBlockState[id];
      const sel = promoSelections.find(p => p.id === id);
      if (st && sel) {
        st.donutMetric = e.target.value;
        st.mediaShare = computePromoMediaShare(promoAnalysisState.rowsA, promoAnalysisState.rowsB, sel.brand, sel.promo, st.donutMetric);
        renderPromoCharts(id);
      }
    }
  });
  monthlySectionsEl.addEventListener("click", (e) => {
    const searchItem = e.target.closest(".promo-search-item[data-promo]");
    const chipRemove = e.target.closest(".promo-chip-remove[data-remove-id]");
    const promoCommentBtn = e.target.closest("[id^='promoCommentBtn-']");
    const promoFollowupToggleMatch = e.target.id.match(/^promoFollowup(\d+)Toggle$/);

    if (e.target.id === "settingDiffCommentBtn") {
      generateSettingDiffComment();
    } else if (e.target.id === "settingDiffFollowupToggle") {
      toggleInlinePanel("settingDiffFollowupPanel");
    } else if (searchItem) {
      addPromoSelection(searchItem.dataset.brand, searchItem.dataset.promo);
    } else if (chipRemove) {
      removePromoSelection(Number(chipRemove.dataset.removeId));
    } else if (promoCommentBtn) {
      generatePromoComment(Number(promoCommentBtn.dataset.promoId));
    } else if (promoFollowupToggleMatch) {
      toggleInlinePanel(`promoFollowup${promoFollowupToggleMatch[1]}Panel`);
    }
  });
  monthlySectionsEl.addEventListener("input", (e) => {
    if (e.target.id === "promoSearchInput") renderPromoSearchResults(e.target.value);
  });
  // Delay hiding the dropdown on blur so a click on a result item still registers first.
  monthlySectionsEl.addEventListener("focusout", (e) => {
    if (e.target.id !== "promoSearchInput") return;
    setTimeout(() => {
      const results = document.getElementById("promoSearchResults");
      if (results) results.style.display = "none";
    }, 150);
  });
  monthlySectionsEl.addEventListener("submit", (e) => {
    if (e.target.id === "settingDiffFollowupForm") {
      e.preventDefault();
      submitFromInlineChat("settingDiffFollowupInput", submitSettingDiffFollowup);
      return;
    }
    const m = e.target.id.match(/^promoFollowup(\d+)Form$/);
    if (m) {
      e.preventDefault();
      const id = Number(m[1]);
      submitFromInlineChat(`promoFollowup${id}Input`, (q) => submitPromoFollowup(id, q));
    }
  });

  function toggleInlinePanel(id) {
    const panel = document.getElementById(id);
    if (panel) panel.style.display = panel.style.display === "none" ? "flex" : "none";
  }
  function submitFromInlineChat(inputId, submitFn) {
    const input = document.getElementById(inputId);
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    submitFn(question);
  }

  function getCheckedTabs() {
    return [...tabSelect.selectedOptions].map(o => o.value);
  }

  function populateTabSelect() {
    const tabs = Object.keys(DATA.tabs);
    tabSelect.innerHTML = tabs.map(t => `<option value="${esc(t)}" selected>${esc(t)}</option>`).join("");
    tabSelect.size = Math.max(1, Math.min(tabs.length, 5));
  }

  // Native <select multiple> normally needs Ctrl/Cmd+click to toggle an option
  // without collapsing the rest of the selection - intercepting mousedown and
  // flipping `selected` manually makes a plain click toggle instead, which is
  // the point of a checkbox-like multi-select but keeps the compact dropdown UI.
  tabSelect.addEventListener("mousedown", (e) => {
    if (e.target.tagName !== "OPTION") return;
    e.preventDefault();
    e.target.selected = !e.target.selected;
    tabSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // Recomputes the merged multi-tab pool whenever the checked tabs change, then
  // constrains the four date inputs to the merged range and (on first load, or when
  // the previous selection falls outside the new range) picks a sensible default:
  // B = the most recent 7 days available, A = the 7 days immediately before that -
  // mirroring the old "auto-select the last two weeks" behavior.
  function updateDateConstraints() {
    const checked = getCheckedTabs();
    DATA_CURRENT = {
      groups: [].concat(...checked.map(t => (DATA.tabs[t] || {}).groups || [])),
      promoGroups: [].concat(...checked.map(t => (DATA.tabs[t] || {}).promoGroups || [])),
    };
    const dates = DATA_CURRENT.groups.map(g => g.date).filter(Boolean).sort();
    const minDate = dates[0] || "";
    const maxDate = dates[dates.length - 1] || "";
    for (const el of [dateAStart, dateAEnd, dateBStart, dateBEnd]) {
      el.min = minDate; el.max = maxDate;
    }
    const needsDefault = !dateBEnd.value || dateBEnd.value < minDate || dateBEnd.value > maxDate
      || !dateAStart.value || dateAStart.value < minDate || dateAStart.value > maxDate;
    if (needsDefault && minDate && maxDate) {
      applyRecentShortcut(minDate, maxDate);
    }
    checkDateOverlap();
    loadNoteForWeek(currentWeekBLabel());
  }

  function applyRecentShortcut(minDate, maxDate) {
    const endB = maxDate;
    const startB = clampDate(shiftDate(endB, -6), minDate, maxDate);
    const endA = clampDate(shiftDate(startB, -1), minDate, maxDate);
    const startA = clampDate(shiftDate(endA, -6), minDate, maxDate);
    dateBEnd.value = endB; dateBStart.value = startB;
    dateAEnd.value = endA; dateAStart.value = startA;
  }

  function checkDateOverlap() {
    const a1 = dateAStart.value, a2 = dateAEnd.value, b1 = dateBStart.value, b2 = dateBEnd.value;
    if (!a1 || !a2 || !b1 || !b2) { dateOverlapWarning.style.display = "none"; return; }
    const overlap = a1 <= b2 && b1 <= a2;
    dateOverlapWarning.style.display = overlap ? "block" : "none";
  }

  const currentWeekBLabel = () => `${dateBStart.value}~${dateBEnd.value}`;

  // data.json (Python) and /api/refresh (Node) both stamp "generatedAt" - shown here
  // so it's clear whether the loaded snapshot is this week's Friday auto-refresh or
  // a live in-session "데이터 최신화" click.
  function updateLastRefreshedHint(iso) {
    const hintEl = document.getElementById("lastRefreshedHint");
    if (!hintEl) return;
    if (!iso) { hintEl.textContent = ""; return; }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) { hintEl.textContent = ""; return; }
    const pad = (n) => String(n).padStart(2, "0");
    hintEl.textContent = `데이터 기준: ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // "데이터 최신화" - re-pulls the sheet via /api/refresh (a Node port of
  // scripts/export_agg.py's aggregation, see that file) and swaps it into DATA for
  // the rest of this session. Never touches the on-disk data.json - re-running the
  // Python script is still how you bake a new snapshot for future page loads.
  async function refreshData() {
    const orig = refreshDataBtn.textContent;
    refreshDataBtn.disabled = true;
    refreshDataBtn.textContent = "최신화 중...";
    const prevTabs = getCheckedTabs();
    const prevA = [dateAStart.value, dateAEnd.value];
    const prevB = [dateBStart.value, dateBEnd.value];
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

      DATA = body;
      updateLastRefreshedHint(body.generatedAt);
      populateTabSelect(); // defaults every tab back to selected
      populateMonthSelects();
      if (prevTabs.length) {
        for (const opt of tabSelect.options) opt.selected = prevTabs.includes(opt.value);
        if (!tabSelect.selectedOptions.length) for (const opt of tabSelect.options) opt.selected = true;
      }
      updateDateConstraints();
      // keep the user's previous A/B range if it's still inside the refreshed data's bounds
      const minD = dateAStart.min, maxD = dateAStart.max;
      if (prevA[0] && prevA[1] && prevA[0] >= minD && prevA[1] <= maxD) { dateAStart.value = prevA[0]; dateAEnd.value = prevA[1]; }
      if (prevB[0] && prevB[1] && prevB[0] >= minD && prevB[1] <= maxD) { dateBStart.value = prevB[0]; dateBEnd.value = prevB[1]; }
      checkDateOverlap();

      refreshDataBtn.textContent = "최신화 완료!";
    } catch (err) {
      refreshDataBtn.textContent = "최신화 실패";
      alert(`데이터 최신화에 실패했습니다.\n${String((err && err.message) || err)}`);
    } finally {
      setTimeout(() => { refreshDataBtn.textContent = orig; refreshDataBtn.disabled = false; }, 1800);
    }
  }

  function runAnalysis() {
    const checkedTabs = getCheckedTabs();
    if (!checkedTabs.length) { alert("분석 탭을 하나 이상 선택하세요."); return; }
    const startA = dateAStart.value, endA = dateAEnd.value;
    const startB = dateBStart.value, endB = dateBEnd.value;
    if (!startA || !endA || !startB || !endB) { alert("A/B 기간의 시작일과 종료일을 모두 선택하세요."); return; }
    if (startA > endA || startB > endB) { alert("각 기간의 시작일은 종료일보다 빠르거나 같아야 합니다."); return; }

    // DATA_CURRENT was already (re)built by updateDateConstraints() whenever the tab
    // checkboxes changed, so it already reflects the currently-checked tabs.
    const weekARange = { start: startA, end: endA };
    const weekBRange = { start: startB, end: endB };
    const weekALabel = `${startA}~${endA}`;
    const weekBLabel = `${startB}~${endB}`;

    const groupsA = aggregateGroupsByDateRange(DATA_CURRENT.groups, startA, endA);
    const groupsB = aggregateGroupsByDateRange(DATA_CURRENT.groups, startB, endB);

    document.getElementById("labelA").textContent = weekALabel;
    document.getElementById("labelB").textContent = weekBLabel;

    // Q&A raw context: tag each row with which period it falls in. A row inside an
    // A/B overlap (user's own choice, just warned about above) matches A first -
    // an acceptable simplification since perfect overlap handling isn't the point.
    const inA = (d) => d >= startA && d <= endA;
    const inB = (d) => d >= startB && d <= endB;
    const qaGroups = DATA_CURRENT.groups
      .filter(g => g.date && (inA(g.date) || inB(g.date)))
      .map(g => ({ ...g, period: inA(g.date) ? "A" : "B" }));
    const qaPromoGroups = DATA_CURRENT.promoGroups
      .filter(p => p.date && (inA(p.date) || inB(p.date)))
      .map(p => ({ ...p, period: inA(p.date) ? "A" : "B" }));

    qaContext = {
      tab: checkedTabs.join(", "), weekLabels: [weekALabel, weekBLabel],
      groups: qaGroups, promoGroups: qaPromoGroups,
    };
    resetQaPanel();

    for (const k of Object.keys(detailBlockState)) delete detailBlockState[k];

    const rev = buildRevenueSection(groupsA, groupsB, weekARange, weekBRange, weekALabel, weekBLabel);
    const signup = buildSignupSection(groupsA, groupsB, weekARange, weekBRange, weekALabel, weekBLabel);
    const app = buildAppSection(groupsA, groupsB, weekARange, weekBRange, weekALabel, weekBLabel);
    const traffic = buildTrafficSection(groupsA, groupsB, weekARange, weekBRange, weekALabel, weekBLabel);

    sectionsEl.innerHTML = buildMediaPerformanceSection(groupsA, groupsB) + rev.html + signup.html + app.html + traffic.html;
    initDetailBlocks();

    const mediaGoalSelect = document.getElementById("mediaGoalSelect");
    if (mediaGoalSelect) {
      renderMediaPerformance(mediaGoalSelect.value);
      mediaGoalSelect.addEventListener("change", () => renderMediaPerformance(mediaGoalSelect.value));
    }

    idleState.style.display = "none";
    reportState.style.display = "block";
    document.getElementById("copyBtn").disabled = false;
    document.getElementById("qaToggleBtn").disabled = false;

    requestAIComments({
      weekA: weekALabel, weekB: weekBLabel,
      note: (weekNoteEl && weekNoteEl.value.trim()) || "",
      매출: rev.promptData, 신규가입: signup.promptData, 앱설치: app.promptData, 트래픽: traffic.promptData,
    });
  }

  function init(data) {
    DATA = data;
    updateLastRefreshedHint(data.generatedAt);
    populateTabSelect();
    updateDateConstraints();
    populateMonthSelects();
    viewModeWeeklyBtn.addEventListener("click", () => setViewMode("weekly"));
    viewModeMonthlyBtn.addEventListener("click", () => setViewMode("monthly"));
    monthlyRunBtn.addEventListener("click", runMonthlyAnalysis);
    tabSelect.addEventListener("change", updateDateConstraints);
    for (const el of [dateAStart, dateAEnd, dateBStart, dateBEnd]) {
      el.addEventListener("change", checkDateOverlap);
    }
    dateBStart.addEventListener("change", () => loadNoteForWeek(currentWeekBLabel()));
    dateBEnd.addEventListener("change", () => loadNoteForWeek(currentWeekBLabel()));
    shortcutRecentBtn.addEventListener("click", () => {
      const dates = DATA_CURRENT.groups.map(g => g.date).filter(Boolean).sort();
      if (!dates.length) return;
      applyRecentShortcut(dates[0], dates[dates.length - 1]);
      checkDateOverlap();
      loadNoteForWeek(currentWeekBLabel());
    });
    refreshDataBtn.addEventListener("click", refreshData);
    refreshDataBtn.disabled = false;

    const slackNotifyCheckbox = document.getElementById("slackNotifyCheckbox");
    slackNotifyCheckbox.checked = localStorage.getItem("slackNotifyEnabled") === "1";
    slackNotifyCheckbox.addEventListener("change", () => {
      localStorage.setItem("slackNotifyEnabled", slackNotifyCheckbox.checked ? "1" : "0");
      document.getElementById("slackNotifyStatus").textContent = "";
    });
    if (weekNoteEl) {
      let saveTimer = null;
      weekNoteEl.addEventListener("input", () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveNoteForWeek(currentWeekBLabel(), weekNoteEl.value), 400);
      });
    }
    runBtn.addEventListener("click", runAnalysis);
    qaToggleBtn.addEventListener("click", () => {
      qaPanel.classList.toggle("open");
      qaToggleBtn.classList.toggle("active", qaPanel.classList.contains("open"));
    });
    qaCloseBtn.addEventListener("click", () => {
      qaPanel.classList.remove("open");
      qaToggleBtn.classList.remove("active");
    });
    qaForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const question = qaInput.value.trim();
      if (!question || !qaContext) return;
      qaInput.value = "";
      submitQaQuestion(question);
    });
    document.getElementById("copyBtn").addEventListener("click", async () => {
      const btn = document.getElementById("copyBtn");
      const orig = btn.textContent;
      const text = commentsToPlainText();
      // AI 코멘트가 아직 로딩 중이거나 실패한 상태(예: 할당량 초과)면 lastComments가 비어 있어
      // 복사할 내용이 없다 - 이 경우 빈 문자열을 조용히 복사해 "복사됨!"으로 착각하게 두지 않는다.
      if (!text.trim()) {
        btn.textContent = "복사할 코멘트 없음";
        setTimeout(() => btn.textContent = orig, 1500);
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "복사됨!";
        setTimeout(() => btn.textContent = orig, 1500);
      } catch (e) {
        alert(text);
      }
    });
    runBtn.disabled = false;
  }

  fetch("data.json")
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(init)
    .catch(err => {
      idleState.style.display = "none";
      errorState.style.display = "block";
      errorState.querySelector(".msg").textContent = String(err.message || err);
    });
})();
