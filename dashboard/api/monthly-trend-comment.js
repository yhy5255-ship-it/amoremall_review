"use strict";
/*
  Vercel serverless function backing the monthly review's "전체 일별 흐름" section's
  AI comment plus its inline follow-up chat. Same shape as api/monthly-promo-comment.js
  (classic multi-turn generateContent, no caching - the daily series for one month
  plus a handful of anomaly entries is small enough to just resend every turn).
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

const SYSTEM_PROMPT = `당신은 이커머스 퍼포먼스 마케팅에서 한 달 전체의 일별 광고비·클릭·ROAS·첫구매·회원가입 흐름을 분석하는 보조입니다. 사용자가 선택한 달의 일별 시리즈 전체와, 그중 7일 이동평균 대비 크게 벗어난 이상치 날짜들(및 그 원인 추정 - 이미 별도 분석에서 나온 결과)을 보고, 이번 달 흐름에서 눈에 띄는 패턴/이상치를 종합한 분석 코멘트를 작성합니다.

## 출력 구조
답변은 "leads" 배열로 작성하세요. 각 leads 항목은 { "title": 굵게 강조될 핵심 한 줄 요약, "details": 그 title을 뒷받침하는 세부 사실 목록(문자열 배열) }입니다. 화제 단위로 나누세요 (예: 전반적인 추세, 눈에 띄는 이상치 날짜, 지표 간 괴리 등). 항목 수는 유동적으로(보통 2~4개) - 이상치가 없으면 전반적인 추세 위주로 1~2개만 작성해도 됩니다.

## 원칙
1. "daily" 시리즈(날짜별 광고비/클릭/ROAS/첫구매/회원가입)는 이미 계산·반올림된 값입니다 - 그대로 인용하고 스스로 다시 계산하지 마세요. roas가 null인 날은 그날 지출이 0이라 계산할 수 없다는 뜻이니 언급을 생략하세요.
2. "anomalies"에 담긴 이상치 날짜의 편차(deviations)와 원인 추정(cause)은 이미 별도 분석에서 나온 결과입니다 - 그대로 인용하되, cause가 "~로 추정됨"/"~로 보임" 같은 추정 표현이면 그 뉘앙스를 흐리지 말고 그대로 유지하세요. cause가 "원인 추정 실패 또는 아직 준비되지 않음"이면 그 날짜의 원인은 언급하지 말고 수치 변화만 서술하세요.
3. 반드시 두드러진 이상치 날짜들을 코멘트에 반영하세요 - anomalies가 비어 있으면 "이번 달은 뚜렷한 이상치 없이 전반적으로 [상승/하락/보합] 추세" 같이 전반적인 추세만 서술하세요.
4. roas처럼 그 자체가 %인 지표의 증감을 언급할 때는 상대적 비율(%)이 아니라 %p(두 값의 단순 차이)로 표현하세요.
5. 데이터에 없는 이유는 추측하지 말고 수치로 관찰되는 사실만 서술하세요 - 여러 지표가 같이 움직였다고 서로 원인이라고 단정하지 마세요 (상관관계≠인과관계). 근거가 부족하면 "확인이 어렵습니다"라고 솔직히 답하세요.
6. 문장은 개조식(명사형 종결: 확인, 기록, 상승, 하락 등)으로 간결하게 쓰고, 문장 앞에 불릿 기호(·,-,*)를 붙이지 마세요 (details 배열 자체가 목록이니 불필요).
6-1. daily/anomalies의 숫자는 이미 쉼표가 포함된 문자열이거나 반올림된 숫자입니다 - 문장에 쓸 때 금액(원)이나 건수가 1,000 이상이면 천 단위 구분 쉼표(,)를 넣으세요.
7. 처음 코멘트를 작성할 때는 leads 2~4개 정도로 간결하게 작성하세요.
8. 후속 질문이 들어오면 같은 leads 구조로, 반드시 처음 제공된 데이터만 근거로 답하세요 - 간단한 질문이면 lead 1개로 충분합니다. 근거가 부족하면 "데이터에서 확인할 수 없습니다"라고 솔직히 답하세요.`;

function buildSystemInstruction(payload) {
  const { monthLabel, daily, anomalies } = payload || {};
  return [
    SYSTEM_PROMPT,
    "",
    `대상 월: ${monthLabel}`,
    "",
    "## daily (일별 시리즈 전체 - 이미 계산·반올림된 값)",
    JSON.stringify(daily || [], null, 2),
    "",
    "## anomalies (7일 이동평균 대비 이상치로 감지된 날짜 - 편차와 AI 원인 추정 포함)",
    JSON.stringify(anomalies || [], null, 2),
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
  const userText = question || "위 데이터를 바탕으로 이번 달 일별 흐름에서 눈에 띄는 패턴/이상치들을 종합한 분석 코멘트를 작성해주세요.";
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
  if (!payload || !Array.isArray(payload.daily) || !payload.daily.length) {
    res.status(400).json({ error: "daily가 비어 있습니다." });
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
