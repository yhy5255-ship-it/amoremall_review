"use strict";
/*
  Vercel serverless function backing the "데이터 최신화" button. Re-pulls the sheet
  and re-aggregates it, the same way scripts/export_agg.py does for the on-disk
  data.json snapshot - but this endpoint never touches the filesystem. Vercel's
  deployed functions have a read-only filesystem (aside from /tmp, which doesn't
  persist across invocations/instances anyway), so "refresh" here means "fetch the
  latest sheet data and hand it to the browser to use for the rest of this session",
  not "overwrite data.json". To bake a new on-disk snapshot for future page loads,
  running `python scripts/export_agg.py` locally is still the way to do that.

  Credentials: prefers GOOGLE_SERVICE_ACCOUNT_KEY_JSON (the full service-account key
  as a JSON string) since that's what a deployed Vercel function can actually read;
  falls back to a local key FILE path (GOOGLE_SERVICE_ACCOUNT_KEY, same env var and
  default export_agg.py uses) for local `vercel dev` parity with the Python script.
*/

const fs = require("fs");
const { JWT } = require("google-auth-library");

const SPREADSHEET_ID = "1-vb3s2ewP1Kl_v3_PGHWrON3mLA6N1OGmyN_NhSC86M";
const MONTH_TAB_RE = /^\d{4}$/; // "2607", "2608", ... - excludes "Index" and other reference tabs
const DEFAULT_KEY_PATH = "c:\\Users\\wisebirds\\.secrets\\arctic-plate-468205-n6-a485ae6332e7.json";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALT_DATE_RE = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/;

// Mirrors export_agg.py's SUSPICIOUS_PROMO_RE - a normal 기획전명(AG) is either a
// "YYMM 4자리 + 설명" name (e.g. "2601상시") or doesn't start with a digit at all;
// 5+ leading digits usually means a date code got concatenated onto another value
// with no separator (real case: AG/AE both held "260881주년" - a sheet input
// error, not something this code produced). Log-only, never alters the value.
const SUSPICIOUS_PROMO_RE = /^\d{5,}/;

function num(s) {
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/,/g, "").replace(/%/g, ""));
  return Number.isNaN(n) ? 0 : n;
}

// Mirrors export_agg.py's normalize_date - the "일" column is already YYYY-MM-DD in
// practice, but this coerces common variants and rejects anything unparseable.
function normalizeDate(d) {
  d = (d || "").trim();
  if (DATE_RE.test(d)) return d;
  const m = ALT_DATE_RE.exec(d);
  if (m) {
    const [, y, mo, da] = m;
    return `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
  }
  return "";
}

function loadCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON);
  }
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || DEFAULT_KEY_PATH;
  return JSON.parse(fs.readFileSync(keyPath, "utf-8"));
}

async function getAccessToken() {
  const creds = loadCredentials();
  const client = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const { token } = await client.getAccessToken();
  return token;
}

// New monthly tabs (2608, 2609, ...) keep getting added to the sheet over time,
// so tabs are discovered automatically instead of a hardcoded list - mirrors
// scripts/export_agg.py's discover_month_tabs().
async function discoverMonthTabs(token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sheets API ${res.status}${body ? `: ${body}` : ""}`);
  }
  const json = await res.json();
  const titles = (json.sheets || []).map(s => s.properties.title);
  return titles.filter(t => MONTH_TAB_RE.test(t)).sort();
}

async function fetchTabValues(tab, token) {
  const range = encodeURIComponent(`${tab}!A4:BL`); // open-ended - see export_agg.py's note on why
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sheets API ${res.status}${body ? `: ${body}` : ""}`);
  }
  const json = await res.json();
  return json.values || [];
}

// Day-level aggregation, field-for-field identical to scripts/export_agg.py's
// export_tab() - see that file's comments for the full column mapping rationale.
function aggregateTab(tabName, rows) {
  if (!rows.length) return null;
  const header = rows[0];
  const dataRows = rows.slice(1);
  const idx = {};
  header.forEach((h, i) => { if (h) idx[h] = i; });
  const col = (name, r) => { const i = idx[name]; return (i == null || i >= r.length) ? "" : r[i]; };

  const groups = new Map();
  const promoGroups = new Map();
  const campaignGroups = new Map();
  const weekLabelsSeen = new Set();
  const warnedPromoNames = new Set(); // dedupe - a bad name repeats across many rows

  for (const r of dataRows) {
    const goal = col("목표", r);
    if (!goal) continue;
    const date = normalizeDate(col("일", r));
    if (!date) continue;
    const weekLabel = col("주차", r);
    if (weekLabel) weekLabelsSeen.add(weekLabel);

    const promoNameCheck = col("기획전명", r);
    if (promoNameCheck && SUSPICIOUS_PROMO_RE.test(promoNameCheck) && !warnedPromoNames.has(promoNameCheck)) {
      warnedPromoNames.add(promoNameCheck);
      console.warn(`[경고] ${tabName} 탭: 기획전명(AG)이 의심스러운 패턴입니다 - ${JSON.stringify(promoNameCheck)} (브랜드/기획전명(AE): ${JSON.stringify(col("브랜드/기획전명", r))})`);
    }

    const spend = num(col("지출 금액 (Gross)", r));
    const gmv = num(col("GMV", r));
    const impr = num(col("노출", r));
    const click = num(col("클릭", r));
    const views = num(col("조회수", r));
    const install = num(col("Airbridge 앱 설치", r));
    const purchaseConv = num(col("총 구매전환", r));
    const firstPurchase = num(col("첫구매", r));
    const firstPurchaseRev = num(col("첫구매 매출", r));
    const signup = num(col("회원가입", r));

    const channel = col("Channel", r), media = col("Media", r), brand = col("브랜드", r), promo = col("기획전명", r);
    const status = col("기획전 상태", r), promoStart = col("기획전 시작날짜", r), promoEnd = col("기획전 종료날짜", r);
    // optimization (AO, "Product / optimization") is part of the key, not just a
    // stored field - see export_agg.py's comment on the same line for why (silent
    // merge of distinct optimization values would break app.js's new-value detection).
    const optimization = col("Product / optimization", r);

    const key = [date, channel, goal, media, brand, promo, status, promoStart, promoEnd, optimization].join("||");
    let g = groups.get(key);
    if (!g) {
      g = {
        date, weekLabel, channel, goal, media, brand, promo, status, promoStart, promoEnd, optimization,
        spend: 0, gmv: 0, impr: 0, click: 0, views: 0,
        firstPurchase: 0, firstPurchaseRev: 0, signup: 0, install: 0, purchaseConv: 0,
      };
      groups.set(key, g);
    }
    g.spend += spend; g.gmv += gmv; g.impr += impr; g.click += click; g.views += views;
    g.firstPurchase += firstPurchase; g.firstPurchaseRev += firstPurchaseRev; g.signup += signup;
    g.install += install; g.purchaseConv += purchaseConv;

    const promoFull = col("브랜드/기획전명", r), material = col("소재명", r);
    const pkey = [date, goal, promoFull, brand, promo, material, status, promoStart, promoEnd].join("||");
    let pg = promoGroups.get(pkey);
    if (!pg) {
      pg = {
        date, weekLabel, goal, promoFull, brand, promo, material, status, promoStart, promoEnd,
        spend: 0, gmv: 0, impr: 0, click: 0, views: 0, firstPurchase: 0, signup: 0, install: 0, purchaseConv: 0,
      };
      promoGroups.set(pkey, pg);
    }
    pg.spend += spend; pg.gmv += gmv; pg.impr += impr; pg.click += click; pg.views += views;
    pg.firstPurchase += firstPurchase; pg.signup += signup; pg.install += install; pg.purchaseConv += purchaseConv;

    // campaignGroups - mirrors export_agg.py's addition for the monthly "캠페인 세팅
    // 변화" diff. rawMedia (B, e.g. "Google AC") is kept separate from the canonical
    // media (AN) used everywhere else - see export_agg.py's comment for why.
    const rawMedia = col("매체", r), campaign = col("캠페인이름", r), group = col("광고그룹 이름", r);
    const ckey = [date, media, campaign, group].join("||");
    let cg = campaignGroups.get(ckey);
    if (!cg) {
      cg = {
        date, weekLabel, goal, media, rawMedia, campaign, group,
        spend: 0, gmv: 0, impr: 0, click: 0, views: 0,
        firstPurchase: 0, signup: 0, install: 0, purchaseConv: 0,
      };
      campaignGroups.set(ckey, cg);
    }
    cg.spend += spend; cg.gmv += gmv; cg.impr += impr; cg.click += click; cg.views += views;
    cg.firstPurchase += firstPurchase; cg.signup += signup; cg.install += install; cg.purchaseConv += purchaseConv;
  }

  const groupList = [...groups.values()];

  const weekRange = new Map();
  for (const g of groupList) {
    if (!g.weekLabel) continue;
    if (!weekRange.has(g.weekLabel)) weekRange.set(g.weekLabel, []);
    weekRange.get(g.weekLabel).push(g.date);
  }
  const weeks = [...weekLabelsSeen].sort((a, b) => {
    const num_ = (s) => (/주차/.test(s) ? parseInt((s.replace("주차", "").split("월").pop() || "").trim(), 10) || 0 : 0);
    return num_(a) - num_(b);
  }).map(w => {
    const ds = (weekRange.get(w) || []).slice().sort();
    return { label: w, start: ds[0] || "", end: ds[ds.length - 1] || "" };
  });

  const allDates = groupList.map(g => g.date).sort();
  const dateRange = allDates.length ? { start: allDates[0], end: allDates[allDates.length - 1] } : { start: "", end: "" };

  return {
    tab: tabName, dateRange, weeks, groups: groupList,
    promoGroups: [...promoGroups.values()], campaignGroups: [...campaignGroups.values()],
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const token = await getAccessToken();
    const tabs = await discoverMonthTabs(token);
    const data = { tabs: {}, generatedAt: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).replace(" ", "T") + "+09:00" };
    for (const tab of tabs) {
      const values = await fetchTabValues(tab, token);
      const tabData = aggregateTab(tab, values);
      if (tabData) data.tabs[tab] = tabData;
    }
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
