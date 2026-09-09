"use strict";
/*
  Vercel serverless function backing the "세팅 변경 히스토리" feature - a small,
  independently-maintained sheet ("아모레_업무 체크" > "히스토리(2609~)") where the
  team manually logs campaign/group/기획전 setting changes as they happen. This is
  a SEPARATE spreadsheet from the main ad-performance tracking sheet, edited by
  hand far more often than the Friday data refresh cycle, so it's fetched live on
  every report run (weekly/monthly) instead of being baked into data.json - a
  third parallel pipeline kept in sync with the Friday refresh would just be
  another version of the two-pipeline-drift bug this project has already hit.

  The sheet's own header note says "G(캠페인명), I(기획전명)은 리포트 RAW와 동일해야함" -
  the team already commits to typing these exactly matching the ad-performance
  RAW values, so app.js matches on trimmed-exact-equality (plus stripping an
  optional "[그룹] " prefix on G - see below) rather than fuzzy/substring matching.

  Uses the SAME service account as the main pipeline (see api/refresh.js) - this
  history sheet just needs that same account invited as a viewer, same as the
  monthly-review reference sheets already are (api/monthly-reference.js).
*/

const fs = require("fs");
const { JWT } = require("google-auth-library");

const DEFAULT_KEY_PATH = "c:\\Users\\wisebirds\\.secrets\\arctic-plate-468205-n6-a485ae6332e7.json";
const HISTORY_SPREADSHEET_ID = "1KbkoFs1d113yBWs-jWYo1R3hkHYyBHoxhxffA0rzkSY";
const HISTORY_TAB = "히스토리(2609~)";
// Rows 1-20 are a title/legend block (헤더 자체는 20행) - real data starts at 21.
const HISTORY_RANGE = `'${HISTORY_TAB}'!A21:L`;

const MONTH_DAY_RE = /(\d{1,2})\s*\/\s*(\d{1,2})/;

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

async function fetchHistoryRows(token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${HISTORY_SPREADSHEET_ID}/values/${encodeURIComponent(HISTORY_RANGE)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sheets API ${res.status}${body ? `: ${body}` : ""}`);
  }
  const json = await res.json();
  return json.values || [];
}

// A row like "[그룹] WEB_Conversion_매출_bang_sl7" in G means "this is a group name,
// not a campaign name" - the team's own convention for disambiguating which kind
// of RAW name is in that cell. Stripped here so app.js can match it against
// either campaign or group names without callers needing to know the prefix.
function parseCampaignCell(raw) {
  const trimmed = (raw || "").trim();
  const m = trimmed.match(/^\[그룹\]\s*(.*)$/);
  if (m) return { name: m[1].trim(), isGroupLevel: true };
  return { name: trimmed, isGroupLevel: false };
}

function parseHistoryRows(rows) {
  const out = [];
  for (const r of rows) {
    const year = (r[1] || "").trim();
    const dateRaw = (r[2] || "").trim();
    if (!year || !dateRaw) continue; // blank rows / bare-year section markers (e.g. a lone "2609")
    const m = MONTH_DAY_RE.exec(dateRaw);
    if (!m) continue;
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    const date = `${year}-${mm}-${dd}`;

    const { name: campaign, isGroupLevel } = parseCampaignCell(r[6]);
    const promo = (r[8] || "").trim();
    const media = [r[3], r[4], r[5]].map(s => (s || "").trim()).filter(Boolean);

    if (!media.length && !campaign && !promo) continue; // nothing to ever match against

    out.push({
      date, dateLabel: dateRaw, media,
      campaign, isGroupLevel,
      promo,
      changeType: (r[9] || "").trim(),
      detail: (r[10] || "").trim(),
      note: (r[11] || "").trim(),
    });
  }
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const token = await getAccessToken();
    const rows = await fetchHistoryRows(token);
    res.status(200).json({ history: parseHistoryRows(rows) });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
