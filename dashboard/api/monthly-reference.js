"use strict";
/*
  Vercel serverless function backing the monthly Q&A panel's "참고 자료 선택" -
  reads past, human-written monthly review spreadsheets (one new sheet per month,
  e.g. "아모레몰 26년 05월 월간리뷰") so the chat can reference them.

  Discovery is LIVE via the Drive API (files shared with the service account),
  not a manually-maintained config file - the dashboard is a shared, multi-user
  tool, so "share a new sheet -> it just shows up" has to work for anyone using the
  deployed site, not just whoever has local repo access to edit/commit/redeploy a
  mapping file. Nothing is cached: every "listSheets"/"listTabs" call re-queries
  Google live, since sheets and their tabs can be shared/renamed/restructured at
  any time between requests.

  Uses the SAME service account as the main data pipeline
  (amoremall-review@arctic-plate-468205-n6.iam.gserviceaccount.com, see
  api/refresh.js) - past review sheets just need that same account invited as a
  viewer, same as the main ad-performance sheet already is. Credentials read the
  same way as api/refresh.js: a JSON string env var for deployed functions, or a
  local key file path for `vercel dev` parity (same env vars, nothing new to set).
*/

const fs = require("fs");
const { JWT } = require("google-auth-library");

const DEFAULT_KEY_PATH = "c:\\Users\\wisebirds\\.secrets\\arctic-plate-468205-n6-a485ae6332e7.json";

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
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  });
  const { token } = await client.getAccessToken();
  return token;
}

// Spreadsheets named like a monthly review (e.g. "아모레몰 26년 05월 월간리뷰") that
// this service account can currently see - filtered so the main ad-performance
// tracking sheet (also shared with this same account) doesn't show up as a
// selectable "review" by mistake. Newest-modified first, since the most recently
// touched review is the one most likely being asked about.
//
// includeItemsFromAllDrives/supportsAllDrives/corpora=allDrives are required -
// both this sheet and the main tracking sheet live in a Shared Drive, and
// files.list() silently returns nothing for Shared Drive content without them
// (confirmed live: a plain files.list() call found 0 files even though the
// service account can read both).
async function listSheets(token) {
  const q = encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and name contains '월간리뷰'");
  const fields = encodeURIComponent("files(id,name,modifiedTime)");
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}` +
    `&orderBy=modifiedTime desc&pageSize=100` +
    `&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=allDrives`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Drive API ${res.status}${body ? `: ${body}` : ""}`);
  }
  const json = await res.json();
  return json.files || [];
}

// Review sheets accumulate a long tail of raw-pull/working tabs (RAW exports,
// content drafts, meeting notes, media-mix scratch work) alongside the real
// analysis tabs. Confirmed against a real sheet that Sheets API's own `hidden`
// flag does NOT line up with which of these the user actually wants (several
// wanted analysis tabs are hidden=true, e.g. working pivots; a couple of unwanted
// ones aren't hidden at all) - so this filters by keyword instead. Exclusion-based
// rather than an allowlist of exact tab names, since the "real" tabs' numbering/
// wording drifts slightly month to month (e.g. "KPF 분석" is tab "2." one month,
// "3." the next) - confirmed these keywords cleanly separate wanted from unwanted
// against two different months' sheets.
const HIDDEN_TAB_KEYWORDS = ["RAW", "인덱스", "성과비교", "미팅록", "미디어믹스", "콘텐츠"];

async function listTabs(spreadsheetId, token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sheets API ${res.status}${body ? `: ${body}` : ""}`);
  }
  const json = await res.json();
  const titles = (json.sheets || []).map(s => s.properties.title);
  return titles.filter(t => !HIDDEN_TAB_KEYWORDS.some(kw => t.includes(kw)));
}

async function fetchTabValues(spreadsheetId, tab, token) {
  const range = encodeURIComponent(tab);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sheets API ${res.status}${body ? `: ${body}` : ""}`);
  }
  const json = await res.json();
  return json.values || [];
}

// Empty rows dropped, each row's cells tab-joined - plain text/values only (images
// in the sheet, e.g. creative thumbnails, are out of scope per the feature's spec).
function rowsToText(rows) {
  return rows
    .filter(r => r.some(c => String(c || "").trim()))
    .map(r => r.map(c => String(c || "").trim()).join("\t"))
    .join("\n");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const action = payload && payload.action;

  try {
    const token = await getAccessToken();

    if (action === "listSheets") {
      const files = await listSheets(token);
      res.status(200).json({ sheets: files.map(f => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime })) });
      return;
    }

    if (!payload || !payload.spreadsheetId) {
      res.status(400).json({ error: "spreadsheetId가 비어 있습니다." });
      return;
    }

    if (action === "listTabs") {
      const tabs = await listTabs(payload.spreadsheetId, token);
      res.status(200).json({ tabs });
      return;
    }

    if (action === "fetchContent") {
      const tabs = Array.isArray(payload.tabs) ? payload.tabs : [];
      if (!tabs.length) {
        res.status(400).json({ error: "tabs가 비어 있습니다." });
        return;
      }
      const parts = [];
      for (const tab of tabs) {
        const rows = await fetchTabValues(payload.spreadsheetId, tab, token);
        parts.push(`### ${tab}\n${rowsToText(rows)}`);
      }
      res.status(200).json({ content: parts.join("\n\n") });
      return;
    }

    res.status(400).json({ error: `알 수 없는 action입니다: ${action}` });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
