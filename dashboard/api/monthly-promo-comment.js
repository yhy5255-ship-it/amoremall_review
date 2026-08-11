"use strict";
/*
  Vercel serverless function backing the monthly review's "특정 기획전 성과 분석"
  AI comment plus its inline follow-up chat. Same shape as api/monthly-comment.js
  (classic multi-turn generateContent, no caching - the payload for one promo's
  weekly series + media share is small enough to just resend every turn) but a
  separate file since the system prompt and payload are about a single promo's
  trend/media-mix, not a set of campaign setting changes.
*/

const { GoogleGenAI } = require("@google/genai");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    leads: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          details: { type: "array", items: { type: "string" } },
        },
        required: ["title", "details"],
        additionalProperties: false,
      },
    },
  },
  required: ["leads"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `당신은 이커머스 퍼포먼스 마케팅에서 특정 기획전 하나의 성과 추이를 분석하는 보조입니다. 사용자가 선택한 기획전의 A월(기준)/B월(비교) 데이터 - 기간별 합계, 주별 추이, 매체별 비중 - 를 보고 자연스러운 분석 코멘트를 작성합니다.

## 출력 구조
답변은 "leads" 배열로 작성하세요. 각 leads 항목은 { "title": 굵게 강조될 핵심 한 줄 요약, "details": 그 title을 뒷받침하는 세부 사실 목록(문자열 배열) }입니다. 보통 아래 3가지 화제를 각각 하나의 lead로 나누세요 (해당 사항이 없으면 생략):
  1) A월 대비 B월 총 지출/GMV/ROAS 증감 요약 (title: 한 줄 결론, details: A월 성과·B월 성과 각각 한 줄씩)
  2) 주별 추이에서 눈에 띄는 지점 (title: 가장 성과가 좋았거나/나빴던 주, 시작·종료 시점 등 핵심 관찰, details: 그 외 보조적인 추이 사실)
  3) 매체별 비중 요약 (title: 비중이 큰 매체, details: 필요시 보충 설명)
예시 (참고용 형태이지 문구를 그대로 쓰라는 뜻은 아님):
  { "title": "기획전 7월 대비 8월 지출액 40% 하락, GMV 80% 하락, ROAS 66%p 하락", "details": ["2026년 7월 성과: 지출액 741,115원, GMV 17,896,110원, ROAS 2,415%", "2026년 8월 성과: 지출액 441,606원, GMV 3,667,820원, ROAS 831%"] }
  { "title": "7월 3주차에 GMV 11,575,860원, ROAS 18,819%로 최대 성과 기록", "details": ["8월 1주차 이후 지출·GMV 발생 없음"] }
  { "title": "매체별 지출은 Google 707,413원(59.8%), Kakaomoment 377,768원(31.9%)에 집중", "details": [] }

## 원칙
1. 브랜드명·기획전명·매체명은 반드시 데이터에 있는 문자열을 한 글자도 바꾸지 말고 그대로 사용하세요. 언급할 때 대괄호로 "[매체명]"처럼 감싸면 화면에서 강조색으로 표시됩니다.
2. "totals" 필드(spendA/gmvA/roasA, spendB/gmvB/roasB)는 이미 정확히 계산된 A월 대비 B월 합계입니다 - 그대로 인용하세요. roas 값이 null이면 해당 기간 지출이 0이라 계산할 수 없다는 뜻이니 언급을 생략하세요.
3. "weeklySeries"는 A월+B월 전체 기간의 주(week, 사내 "주차" 기준)별 추이입니다 - 각 항목에 spend/gmv/roas/cvr/ctr/cpc/cpi/firstPurchase/firstPurchaseCpa/signup/signupCpa가 이미 계산되어 있습니다. 값이 null인 지표는 분모가 0이라 계산할 수 없다는 뜻이니 언급을 생략하세요. 눈에 띄는 추세(상승/하락/특정 주 급증·급감, 기획전이 시작되거나 끝난 것으로 보이는 주 등)를 이 값들을 그대로 인용해서 짚어주세요 - 직접 재계산하지 마세요.
4. "mediaShare"는 매체별 "value"(mediaShareMetric에 적힌 지표 기준 값)와 비중(pct, %)입니다 - mediaShareMetric이 무엇인지 먼저 확인하고, 그 지표 기준으로 비중이 두드러지게 큰 매체(대략 30% 이상)가 있으면 반드시 언급하세요.
5. 데이터에 없는 이유(왜 특정 시점에 성과가 변했는지 등)는 추측하지 말고, 수치로 관찰되는 사실만 서술하세요.
6. 문장은 개조식(명사형 종결: 확인, 기록, 상승, 하락, 집중 등)으로 간결하게 쓰고, 문장 앞에 불릿 기호(·,-,*)를 붙이지 마세요 (details 배열 자체가 목록이니 불필요).
6-1. totals/weeklySeries/mediaShare의 숫자는 쉼표 없는 원본값입니다 - 금액(원)이나 건수가 1,000 이상이면 문장에 쓸 때 반드시 천 단위 구분 쉼표(,)를 직접 넣으세요 (예: "27360원"이 아니라 "27,360원").
6-2. roas/cvr/ctr처럼 그 자체가 %인 지표의 증감은 상대적 비율(%)이 아니라 %p(두 값의 단순 차이, percentage point)로 표현하세요 - 예를 들어 ROAS가 1000%에서 1230%가 됐다면 "+23%"가 아니라 "+230%p"라고 쓰세요. 그 외 금액·건수 지표의 증감은 평소대로 상대적 비율(%)로 표현하세요.
7. 처음 코멘트를 작성할 때는 트렌드 요약과 매체 기여도를 포함해 leads 2~4개 정도로 작성하세요.
8. 후속 질문이 들어오면 같은 leads 구조로, 반드시 처음 제공된 데이터를 근거로 답하세요 - 간단한 질문이면 lead 1개로 충분합니다. 근거가 부족하면 "데이터에서 확인할 수 없습니다"라고 솔직히 답하세요.`;

function buildSystemInstruction(payload) {
  const { brand, promo, monthALabel, monthBLabel, totals, weeklySeries, mediaShareMetric, mediaShare } = payload || {};
  return [
    SYSTEM_PROMPT,
    "",
    `기획전: ${brand} · ${promo}`,
    `A월(기준): ${monthALabel}`,
    `B월(비교): ${monthBLabel}`,
    "",
    "## totals (A월/B월 기간 합계 - 이미 계산·반올림된 값)",
    JSON.stringify(totals || {}, null, 2),
    "",
    "## weeklySeries (A월+B월 전체 주별 추이 - 이미 계산·반올림된 값)",
    JSON.stringify(weeklySeries || [], null, 2),
    "",
    `## mediaShare (매체별 비중 - 기준 지표: ${mediaShareMetric || "지출"})`,
    JSON.stringify(mediaShare || [], null, 2),
  ].join("\n");
}

// {role, content}[] -> Content[], same shape as api/qa.js's toContents(). The
// very first call (no history yet) gets a fixed instruction asking for the
// initial comment; every later call is a real follow-up question.
function toContents(history, question) {
  const contents = (history || []).map(h => ({
    role: h.role === "model" ? "model" : "user",
    parts: [{ text: String(h.content || "") }],
  }));
  const userText = question || "위 데이터를 바탕으로 이 기획전의 트렌드와 매체 기여도를 분석하는 코멘트를 작성해주세요.";
  contents.push({ role: "user", parts: [{ text: userText }] });
  return contents;
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
  if (!payload || !payload.brand || !payload.promo) {
    res.status(400).json({ error: "brand/promo가 비어 있습니다." });
    return;
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: toContents(payload.history, payload.question),
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        systemInstruction: buildSystemInstruction(payload),
      },
    });
    if (!response.text) throw new Error("AI 응답에서 텍스트를 찾지 못했습니다.");
    const parsed = JSON.parse(response.text);
    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: extractErrorMessage(err) });
  }
};

// Same shape as api/qa.js's extractErrorMessage - the SDK's top-level err.message
// is a generic wrapper; the useful text is nested in err.body or err.message itself.
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
