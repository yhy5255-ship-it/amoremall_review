"use strict";
/*
  Vercel serverless function backing the "AI에게 질문하기" side panel. Separate
  endpoint from api/comment.js (which auto-generates the weekly report) - this one
  answers free-form questions grounded in the RAW group data for the currently
  selected tab/weeks (not the summarized numbers app.js computes for the report),
  so the model can answer things the report's pre-computed fields don't cover.

  Two token-saving layers apply to different phases of the same conversation:

  1. Minimal per-turn data (app.js's buildQaScopedData): every turn sends only the
     goal(s)/brand/promo the question seems to be about, aggregated to brand+promo
     and stripped of goal-irrelevant fields. This answers turn 1, and is also what
     this file falls back to if a held cache turns out to be invalid.

  2. Context caching (this file, from turn 2 onward): once there's at least one
     prior Q+A pair, app.js additionally attaches the FULL unfiltered dataset once.
     This file uses that to seed a Gemini context cache (ai.caches.create) and
     returns the cache's resource name; app.js then just passes that name back on
     later turns instead of resending any data. A cache only pays off if its content
     is byte-identical across reuses (Gemini hashes/matches the cached prefix), which
     is exactly why it's built from the FULL data rather than a per-question slice -
     a cache that changed shape every turn would never hit.

  Multi-turn conversation itself uses the classic models.generateContent surface
  (contents: Content[] with role "user"/"model") rather than the Interactions API
  api/comment.js uses - the installed @google/genai version's Interactions API
  (ai.interactions.create) has no `cachedContent` field on its request config;
  `cachedContent` only exists on GenerateContentConfig (confirmed by reading the
  installed package's own .d.ts, not just docs). Since caching is the whole point
  here, this file uses ai.models.generateContent instead.

  api/comment.js is a one-shot call with no session, so it's explicitly out of
  scope for both of the above - it's untouched.
*/

const { GoogleGenAI } = require("@google/genai");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const CACHE_TTL = "1800s"; // 30min - a Q&A session isn't expected to run much longer than this

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    // Populated only when the answer compares several campaigns/media - a single-value
    // answer has nothing worth tabulating, so this stays null most of the time.
    table: {
      type: "object",
      nullable: true,
      properties: {
        columns: { type: "array", items: { type: "string" } },
        rows: { type: "array", items: { type: "array", items: { type: "string" } } },
      },
      required: ["columns", "rows"],
      additionalProperties: false,
    },
  },
  required: ["answer", "table"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `당신은 이커머스 퍼포먼스 마케팅 데이터를 근거로 질문에 답하는 분석 보조입니다. 사용자가 대시보드에 로드된 특정 탭·주차 범위의 원본 집계 데이터를 보고 자유롭게 질문하면, 아래 원칙에 따라 답합니다.

## 원칙
0. 기획전명·브랜드명·매체명은 반드시 데이터에 있는 문자열을 한 글자도 바꾸지 말고 그대로 사용하세요. 정확히 기억나지 않으면 차라리 해당 항목 언급을 생략하세요 - 틀린 이름을 쓰는 것보다 낫습니다. 서로 다른 브랜드가 같은 기획전명을 쓰는 경우가 있으니, 특정 기획전을 언급할 때는 가능하면 "브랜드 · 기획전명" 형태로 함께 써서 혼동을 피하세요 (예: "헤라 · 2601상시").
1. 사실과 해석 구분: 답변 안에서 "데이터에 나온 사실"과 "그로부터의 해석/추론/가능성"을 명확히 구분해서 서술하세요. 근거 없는 원인·의도·감정·미래 결과를 추정하지 마세요.
2. 상관관계 ≠ 인과관계: 두 지표가 같이 움직였다고 해서 하나가 다른 하나의 원인이라고 단정하지 마세요. "동시에 관찰됨" 정도로만 표현하세요.
3. 불확실성·데이터 부족: 주어진 데이터로 답할 근거가 부족하면 "모릅니다"라고 명확히 답하세요. 데이터가 없거나 서로 충돌하면 "정확한 답변이 어렵습니다"라고 밝히고 왜 그런지 설명하세요. 지금 받은 데이터에 특정 목표(goal)나 소재·매체 세부 항목이 아예 빠져 있을 수 있습니다 - 그런 항목에 대한 질문이면 억지로 추측하지 말고 데이터에 없다고 답하세요.
4. 질문이 지금 로드된 탭/주차 범위를 벗어난 내용이면(예: 데이터에 없는 기간을 물어봄), 억지로 답하지 말고 현재 데이터의 범위(탭, A/B 주차)를 안내하세요.
5. 숫자를 언급할 때 ROAS·%p는 정수로, 그 외 비율(%)은 소수점 둘째 자리까지로 표현하세요. 금액(원)이나 건수가 1,000 이상이면 반드시 천 단위 구분 쉼표(,)를 넣어 쓰세요 (예: "27360원"이 아니라 "27,360원", "15000건"이 아니라 "15,000건") - 퍼센트에는 쉼표를 넣지 않습니다. table에 넣는 숫자도 동일하게 쉼표를 넣으세요.
6. 답변은 실무자에게 말하듯 자연스러운 대화체 문단으로, 불필요하게 길게 늘이지 말고 핵심만 2~6문장으로 답하세요.
7. 질문이 여러 기획전/매체/브랜드를 비교하는 성격이면(예: "TOP 3 알려줘", "A랑 B 비교해줘"), 그 근거가 된 수치를 "table"에 표 형태로 함께 정리하세요. 단일 값 질문이거나 표로 정리할 게 없으면 "table"은 반드시 null로 두세요 - table이 없다고 답변이 실패한 게 아니니 answer는 항상 정상적으로 채우세요. 표는 한 번에 20행을 넘기지 마세요(넘으면 상위 20개만). table의 열/값에 들어가는 기획전명·브랜드명·매체명도 원칙 0과 동일하게 데이터에 있는 문자열 그대로 사용하세요.
8. "총/전체/합계/몇 건" 같이 특정 목표(goal)의 전체 합계를 묻는 질문에는 반드시 "totals" 필드의 값을 그대로 인용하세요 - "summary"에 있는 개별 기획전 행들을 직접 더해서 답하지 마세요. summary는 기획전이 여러 개로 쪼개져 있어 직접 암산으로 합산하면 틀리기 쉽습니다. totals에 없는 조합(예: 여러 목표를 합친 합계)을 물어보면, 있는 것끼리만 각각 answer하거나 "모릅니다"라고 답하세요 - 임의로 새로 더하지 마세요.

## 데이터 안내
"totals"는 목표(goal)별 × 기간(A/B)별로 이미 정확히 계산되어 있는 합계입니다 (spend/gmv/firstPurchase/signup/install 등) - 합계가 필요한 질문은 이걸 그대로 쓰세요. "summary"는 비교 기간(A/B) × 브랜드 × 기획전 단위로 집계된 상세 내역이고, 각 행의 "period" 필드가 "A"(기준 기간) 또는 "B"(비교 대상 기간)를 나타냅니다 - 특정 기획전을 콕 집어 묻는 질문에 쓰세요. "detailGroups"가 있으면 그 위에 채널·매체 단위까지 더 쪼갠 원본 집계이고, "promoGroups"가 있으면 소재(광고 크리에이티브) 단위 집계입니다. 질문과 관련이 적어 보이는 항목은 아예 생략되어 올 수 있습니다 - 그런 경우 억지로 추측하지 말고 원칙 3에 따라 답하세요. 모든 데이터는 안내된 탭과 A/B 기간 범위로 한정되어 있습니다 - A/B는 반드시 calendar 주(week)가 아니라 사용자가 자유롭게 고른 날짜 범위일 수 있습니다.`;

// ROAS·%p는 정수, 비율(%)류는 소수점 둘째 자리까지 - api/comment.js와 동일한 규칙을
// 여기서도 그대로 적용한다 (요청이 명시적으로 지정한 공유 방식: 간단히 복붙).
function roundForPrompt(value) {
  if (Array.isArray(value)) return value.map(roundForPrompt);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "number") {
        if (/roas/i.test(k) || /pct$/i.test(k) || /share/i.test(k)) out[k] = Math.round(v);
        else if (/(ctr|cvr|rate)/i.test(k)) out[k] = Math.round(v * 100) / 100;
        else out[k] = Math.round(v);
      } else {
        out[k] = roundForPrompt(v);
      }
    }
    return out;
  }
  return value;
}

function contextHeader(payload) {
  return [
    `현재 로드된 분석 탭: ${payload.tab}`,
    `현재 로드된 비교 기간(A/B): ${(payload.weekLabels || []).join(", ")}`,
  ].join("\n");
}

// The no-cache / fallback path: small, question-scoped data (app.js already filtered it).
function buildScopedContext(payload) {
  const scoped = roundForPrompt(payload.scopedData || {});
  return [
    SYSTEM_PROMPT,
    "",
    contextHeader(payload),
    "",
    "## totals (목표별·기간별 이미 계산된 합계 - 합계 질문엔 이걸 그대로 인용)",
    JSON.stringify(scoped.totals || {}, null, 2),
    "",
    "## summary (기간(A/B)·브랜드·기획전 단위 집계)",
    JSON.stringify(scoped.summary || [], null, 2),
    scoped.detailGroups ? `\n## detailGroups (채널·매체 단위 상세)\n${JSON.stringify(scoped.detailGroups, null, 2)}` : "",
    scoped.promoGroups ? `\n## promoGroups (소재 단위 집계)\n${JSON.stringify(scoped.promoGroups, null, 2)}` : "",
  ].join("\n");
}

// Same reasoning as the scoped path's "totals" (see app.js's computeQaTotals) - the
// cached context still needs a pre-computed, always-correct total per goal/period,
// since the raw "groups" list here can run into the hundreds of rows and asking the
// model to sum that many rows itself is unreliable. Computed from the UNROUNDED
// source so per-row rounding doesn't compound into the total; the total itself is
// rounded once at the end.
function computeTotalsByGoal(groups) {
  const totals = {};
  for (const g of groups || []) {
    if (!totals[g.goal]) totals[g.goal] = { spendA: 0, spendB: 0, gmvA: 0, gmvB: 0, firstPurchaseA: 0, firstPurchaseB: 0, signupA: 0, signupB: 0, installA: 0, installB: 0 };
    const t = totals[g.goal];
    const suffix = g.period === "A" ? "A" : "B";
    t["spend" + suffix] += g.spend || 0;
    t["gmv" + suffix] += g.gmv || 0;
    t["firstPurchase" + suffix] += g.firstPurchase || 0;
    t["signup" + suffix] += g.signup || 0;
    t["install" + suffix] += g.install || 0;
  }
  return totals;
}

// The cache-seeding path: the FULL unfiltered dataset, sent once by app.js on the
// "graduation" turn - has to be the complete picture since the cache must answer
// whatever the session's later, unrelated-goal questions turn out to be.
function buildFullCacheContext(payload) {
  const totalsByGoal = roundForPrompt(computeTotalsByGoal((payload.fullData || {}).groups));
  const full = roundForPrompt(payload.fullData || {});
  return [
    SYSTEM_PROMPT,
    "",
    contextHeader(payload),
    "",
    "## totals (목표별·기간별 이미 계산된 합계 - 합계 질문엔 이걸 그대로 인용)",
    JSON.stringify(totalsByGoal, null, 2),
    "",
    "## groups (전체 원본 집계)",
    JSON.stringify(full.groups || [], null, 2),
    "",
    "## promoGroups (전체 소재 단위 집계)",
    JSON.stringify(full.promoGroups || [], null, 2),
  ].join("\n");
}

// {role, content}[] -> Content[] for generateContent's multi-turn `contents`.
function toContents(history, question) {
  const contents = (history || []).map(h => ({
    role: h.role === "model" ? "model" : "user",
    parts: [{ text: String(h.content || "") }],
  }));
  contents.push({ role: "user", parts: [{ text: String(question || "") }] });
  return contents;
}

// Server-side backstop in case app.js's keyword filter still matched almost
// everything: drop the heavier optional pieces before they reach Gemini. summary
// alone is usually enough to answer most questions, so it's the last thing kept.
function capScopedData(scopedData) {
  if (!scopedData) return scopedData;
  const capped = { ...scopedData };
  let size = JSON.stringify(capped).length;
  if (size > 150000 && capped.detailGroups) { delete capped.detailGroups; size = JSON.stringify(capped).length; }
  if (size > 150000 && capped.promoGroups) { delete capped.promoGroups; }
  return capped;
}

async function callGemini(ai, { contents, systemInstruction, cachedContent }) {
  const config = { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA };
  if (cachedContent) config.cachedContent = cachedContent;
  else config.systemInstruction = systemInstruction;
  const response = await ai.models.generateContent({ model: MODEL, contents, config });
  if (!response.text) throw new Error("AI 응답에서 텍스트를 찾지 못했습니다.");
  return JSON.parse(response.text);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ error: "GEMINI_API_KEY가 서버에 설정되어 있지 않습니다." });
    return;
  }

  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  if (!payload || !payload.question) {
    res.status(400).json({ error: "question이 비어 있습니다." });
    return;
  }
  payload.scopedData = capScopedData(payload.scopedData);

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const contents = toContents(payload.history, payload.question);

  try {
    // 1) Client is holding a cache from an earlier turn in this session - try it first.
    if (payload.cacheName) {
      try {
        const parsed = await callGemini(ai, { contents, cachedContent: payload.cacheName });
        res.status(200).json({ ...parsed, cacheName: payload.cacheName });
        return;
      } catch (_cacheErr) {
        // Expired/invalid - fall through and answer without it below (fresh cache
        // creation only happens on the client's *next* fullData-bearing turn).
      }
    }

    // 2) No usable cache yet. If app.js attached the full dataset, this is the
    //    "graduation" turn (2nd question of the session) - try seeding a cache.
    let newCacheName = null;
    if (!payload.cacheName && payload.fullData) {
      try {
        const cache = await ai.caches.create({
          model: MODEL,
          config: {
            systemInstruction: buildFullCacheContext(payload),
            ttl: CACHE_TTL,
            displayName: `qa-${payload.tab}-${(payload.weekLabels || []).join("_")}`,
          },
        });
        newCacheName = cache.name || null;
      } catch (_createErr) {
        // Caching unsupported for this model/account, or the payload didn't meet
        // the API's minimum size - just answer this turn without one.
        newCacheName = null;
      }
    }

    if (newCacheName) {
      try {
        const parsed = await callGemini(ai, { contents, cachedContent: newCacheName });
        res.status(200).json({ ...parsed, cacheName: newCacheName });
        return;
      } catch (_useErr) {
        // Created but couldn't be used on this call - still answer via the
        // scoped fallback below rather than failing the request outright.
      }
    }

    // 3) No cache (none held, none created, or unusable) - answer from the minimal
    //    per-question scoped data. cacheName: null tells the client to try seeding
    //    a fresh cache again on its next fullData-bearing turn.
    const parsed = await callGemini(ai, { contents, systemInstruction: buildScopedContext(payload) });
    res.status(200).json({ ...parsed, cacheName: null });
  } catch (err) {
    res.status(500).json({ error: extractErrorMessage(err) });
  }
};

// The SDK wraps the API's real error message one level down - sometimes in
// err.body (interactions-style errors), sometimes it's already what err.message
// stringified to (models.generateContent-style errors, which can itself be the
// raw JSON blob). Try both shapes before giving up and returning the raw text.
function extractErrorMessage(err) {
  for (const raw of [err && err.body, err && err.message]) {
    try {
      const body = typeof raw === "string" ? JSON.parse(raw) : raw;
      const nested = Array.isArray(body) ? body[0] : body;
      if (nested && nested.error && nested.error.message) return nested.error.message;
    } catch (_) {
      // not JSON - try the next candidate
    }
  }
  return String((err && err.message) || err);
}
