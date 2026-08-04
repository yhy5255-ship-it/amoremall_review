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

  // Same idea for the AE/AF/AG/AW-level promoGroups feeding the TOP5 leaderboard.
  function aggregatePromoGroupsByDateRange(rows, start, end) {
    const m = new Map();
    for (const p of rows) {
      if (!p.date || p.date < start || p.date > end) continue;
      const key = [p.goal, p.promoFull, p.brand, p.promo, p.material, p.status, p.promoStart, p.promoEnd].join("||");
      if (!m.has(key)) m.set(key, {
        goal: p.goal, promoFull: p.promoFull, brand: p.brand, promo: p.promo, material: p.material,
        status: p.status, promoStart: p.promoStart, promoEnd: p.promoEnd,
        spend: 0, gmv: 0, impr: 0, click: 0, views: 0, firstPurchase: 0, signup: 0, install: 0, purchaseConv: 0,
      });
      const o = m.get(key);
      o.spend += p.spend; o.gmv += p.gmv; o.impr += p.impr; o.click += p.click; o.views += (p.views || 0);
      o.firstPurchase += p.firstPurchase; o.signup += p.signup; o.install += p.install; o.purchaseConv += p.purchaseConv;
    }
    return [...m.values()];
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

  // ---------- top-promo leaderboard (uses AE/AF/AG/AW breakdown; filterable by 목표, rankable by 5 metrics) ----------
  function groupPromoInstances(promoRows) {
    const m = new Map();
    for (const p of promoRows) {
      const key = p.promoFull || (p.brand + "_" + p.promo);
      if (!m.has(key)) m.set(key, {
        promoFull: key, brand: p.brand, promo: p.promo, status: p.status,
        promoStart: p.promoStart, promoEnd: p.promoEnd,
        spend: 0, gmv: 0, impr: 0, click: 0, views: 0, firstPurchase: 0, signup: 0, install: 0, purchaseConv: 0, materials: []
      });
      const o = m.get(key);
      o.spend += p.spend; o.gmv += p.gmv; o.impr += p.impr; o.click += p.click; o.views += p.views;
      o.firstPurchase += p.firstPurchase; o.signup += p.signup; o.install += p.install; o.purchaseConv += p.purchaseConv;
      if (p.material) o.materials.push(p);
    }
    return [...m.values()];
  }

  const GOAL_ORDER = ["매출", "신규가입", "앱설치", "트래픽"];

  const TOP_METRICS = {
    gmv:   { label: "매출(GMV)",   dir: -1, val: p => p.gmv,                                   main: p => fmtWonAbbrev(p.gmv),                            sub: p => `ROAS ${fmtPct(roas(p.gmv, p.spend))}` },
    roas:  { label: "ROAS",        dir: -1, val: p => roas(p.gmv, p.spend),                    main: p => fmtPct(roas(p.gmv, p.spend)),                   sub: p => `매출 ${fmtWonAbbrev(p.gmv)}` },
    fp:    { label: "첫구매 수",    dir: -1, val: p => p.firstPurchase,   filter: p => p.firstPurchase > 0, main: p => fmtCount(p.firstPurchase),           sub: p => `첫구매 CPA ${fmtWon(p.spend / p.firstPurchase)}` },
    fpCpa: { label: "첫구매 CPA",   dir: 1,  val: p => p.spend / p.firstPurchase, filter: p => p.firstPurchase > 0 && p.spend > 0, main: p => fmtWon(p.spend / p.firstPurchase), sub: p => `첫구매 ${fmtCount(p.firstPurchase)}` },
    su:    { label: "회원가입 수",  dir: -1, val: p => p.signup,          filter: p => p.signup > 0,        main: p => fmtCount(p.signup),                  sub: p => `가입 CPA ${fmtWon(p.spend / p.signup)}` },
    suCpa: { label: "회원가입 CPA", dir: 1,  val: p => p.spend / p.signup, filter: p => p.signup > 0 && p.spend > 0, main: p => fmtWon(p.spend / p.signup),          sub: p => `회원가입 ${fmtCount(p.signup)}` },
  };

  function rankByMetric(list, metricKey) {
    const m = TOP_METRICS[metricKey];
    const pool = m.filter ? list.filter(m.filter) : list;
    return [...pool].sort((a, b) => m.dir === -1 ? m.val(b) - m.val(a) : m.val(a) - m.val(b));
  }

  let topPromoRaw = [];  // all promoGroups rows for the rendered week (every 목표), kept for the 목표 dropdown
  let topPromoPool = []; // instances grouped for the currently selected 목표, kept for the metric dropdown

  function updateTopPromoPool(goal) {
    const instances = groupPromoInstances(topPromoRaw.filter(p => p.goal === goal));
    topPromoPool = instances.filter(p => p.spend > 0 || p.gmv > 0);
  }

  function renderTopPromoBoard(metricKey) {
    const body = document.getElementById("topPromoBody");
    if (!body) return;
    const m = TOP_METRICS[metricKey];
    const top = rankByMetric(topPromoPool, metricKey).slice(0, 5);
    if (!top.length) { body.innerHTML = `<p class="empty-note">이 지표로 순위를 매길 데이터가 없습니다.</p>`; return; }
    const period = (s, e) => (!e || e === "상시") ? "상시 운영" : `${fmtDate(s)}~${fmtDate(e)}`;
    body.innerHTML = `<div class="board">${top.map((p, i) => {
      const bestMat = [...p.materials].sort((a, b) => b.gmv - a.gmv)[0];
      return `<div class="board-item">
        <div class="board-rank${i === 0 ? " r1" : ""}">${i + 1}</div>
        <div class="board-main">
          <div class="name">${esc(p.brand)} · ${esc(p.promo)}</div>
          <div class="meta">${period(p.promoStart, p.promoEnd)} · 구매 ${fmtCount(p.purchaseConv)} · 첫구매 ${fmtCount(p.firstPurchase)} · 회원가입 ${fmtCount(p.signup)}</div>
          ${bestMat ? `<div class="best-material"><span class="k">베스트 소재</span> ${esc(bestMat.material || "-")} · 매출 ${fmtWonAbbrev(bestMat.gmv)} · 구매 ${fmtCount(bestMat.purchaseConv)}</div>` : ""}
        </div>
        <div class="board-nums">
          <div class="gmv">${m.main(p)}</div>
          <div class="roas">${m.sub(p)}</div>
        </div>
      </div>`;
    }).join("")}</div>`;
  }

  function buildTopPromoSection(promoGroupsB) {
    topPromoRaw = promoGroupsB || [];
    if (!topPromoRaw.length) return "";
    const goals = GOAL_ORDER.filter(g => topPromoRaw.some(p => p.goal === g));
    if (!goals.length) return "";
    const defaultGoal = goals.includes("매출") ? "매출" : goals[0];
    updateTopPromoPool(defaultGoal);
    if (!topPromoPool.length) return "";

    const goalOptions = goals.map(g => `<option value="${g}"${g === defaultGoal ? " selected" : ""}>${g}</option>`).join("");
    const metricOptions = Object.entries(TOP_METRICS).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join("");

    return `
    <section class="section-card" data-ch="TOP">
      <div class="section-title">
        <span class="tag">INSIGHT</span><h3>이번주 우수 기획전 TOP 5</h3>
        <select id="topGoalSelect" class="top-metric-select">${goalOptions}</select>
        <select id="topMetricSelect" class="top-metric-select">${metricOptions}</select>
      </div>
      <div id="topPromoBody"></div>
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
      populateTabSelect(); // defaults every tab back to selected
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

    const promoGroupsB = aggregatePromoGroupsByDateRange(DATA_CURRENT.promoGroups, startB, endB);

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

    sectionsEl.innerHTML = buildTopPromoSection(promoGroupsB) + rev.html + signup.html + app.html + traffic.html;
    initDetailBlocks();

    const topGoalSelect = document.getElementById("topGoalSelect");
    const topMetricSelect = document.getElementById("topMetricSelect");
    if (topMetricSelect) {
      renderTopPromoBoard(topMetricSelect.value);
      topGoalSelect.addEventListener("change", () => {
        updateTopPromoPool(topGoalSelect.value);
        renderTopPromoBoard(topMetricSelect.value);
      });
      topMetricSelect.addEventListener("change", () => renderTopPromoBoard(topMetricSelect.value));
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
    populateTabSelect();
    updateDateConstraints();
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
