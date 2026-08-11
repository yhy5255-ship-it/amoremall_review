"use strict";
/*
  Vercel serverless function backing two of the monthly review's AI comments -
  "이달 캠페인 세팅 변화" (default/legacy payload shape, no "type" field) and the
  MEDIA 매체 성과 section's comment ("type": "mediaPerformance") - plus each one's
  inline follow-up chat. Both payloads are small, so unlike api/qa.js there's no
  need for context caching - every turn (the initial comment and each follow-up)
  resends the same small item list as system context and goes through classic
  multi-turn contents (history + question), same generateContent surface qa.js uses.
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

const SETTING_DIFF_SYSTEM_PROMPT = `당신은 이커머스 퍼포먼스 마케팅의 캠페인 세팅(신규 추가/종료) 변화를 분석하는 보조입니다. 사용자가 두 달(A=기준월, B=비교월)을 비교해 선택한 캠페인/광고그룹의 신규 추가·종료 내역과 관련 성과 수치를 보고, 자연스러운 분석 코멘트를 작성합니다.

## 출력 구조
답변은 "leads" 배열로 작성하세요. 각 leads 항목은 { "title": 굵게 강조될 핵심 한 줄 요약, "details": 그 title을 뒷받침하는 세부 사실 목록(문자열 배열) }입니다. 하나의 화제(예: "이 캠페인은 지출 규모가 크다", "저 캠페인은 종료 직전 성과가 좋았다")마다 leads 항목을 하나씩 나누세요 - 서로 다른 화제를 details 하나에 섞지 마세요. title은 그 화제의 결론을 한 줄로, details는 근거가 되는 구체적 수치를 나눠서 담으세요. 항목 수는 다루는 내용에 맞게 유동적으로 정하되(보통 1~4개), 선택된 항목이 여러 개면 각각 최소 1개의 lead로 짚어주세요.

## 원칙
1. 매체명·캠페인명·그룹명은 반드시 데이터에 있는 문자열을 한 글자도 바꾸지 말고 그대로 사용하세요. 언급할 때 대괄호로 "[매체명]" 또는 "[캠페인명]"처럼 감싸면 화면에서 강조색으로 표시됩니다.
2. "kind": "new" 항목은 B월에 새로 생긴 캠페인/그룹이고, "kind": "ended" 항목은 A월에는 있었지만 B월엔 없는 캠페인/그룹입니다. isNewCampaign이 true면 캠페인 자체가 이번에 처음 생긴 것이고, isEndedCampaign이 true면 캠페인 전체가 이번에 종료된 것입니다 - 이 구분을 명확히 언급하세요.
3. 각 항목의 "spend"와 목표(goal)별 "kpis" 필드는 이미 정확히 계산·반올림되어 있는 값입니다 - 그대로 인용하세요. goal이 "매출"이면 kpis에 구매수/GMV/ROAS/CVR이, "신규가입"이면 첫구매수/첫구매CPA/회원가입수/회원가입CPA가, "트래픽"이면 클릭수/CTR/CPC가, "앱설치"면 앱설치수/CPI가 들어 있습니다. 값이 "-"인 지표는 분모가 0이라 계산할 수 없다는 뜻이니 그 지표는 언급을 생략하세요. 절대 spend나 kpis의 숫자를 스스로 다시 나누거나 계산하지 마세요.
4. 신규 항목은 kpis를 근거로 적은 지출로 테스트 중인지 이미 규모 있게 집행 중인지, 종료 항목은 종료 직전 성과가 좋았는데 종료된 것인지 저조해서 종료된 것으로 보이는지를 언급하면 좋습니다.
5. 데이터에 없는 이유(왜 신규로 추가했는지, 왜 종료했는지)는 추측하지 말고, kpis로 관찰되는 사실만 서술하세요.
6. 문장은 개조식(명사형 종결: 확인, 추가, 종료, 기록 등)으로 간결하게 쓰고, 문장 앞에 불릿 기호(·,-,*)를 붙이지 마세요 (details 배열 자체가 목록이니 불필요).
6-1. 금액(원)이나 건수가 1,000 이상이면 반드시 천 단위 구분 쉼표(,)를 넣어 쓰세요 (예: "27360원"이 아니라 "27,360원"). items의 spend/kpis 값은 이미 쉼표가 포함된 문자열이니 그대로 옮기면 되고, mediaContext의 숫자는 쉼표 없는 원본값이니 문장에 쓸 때 직접 쉼표를 넣으세요.
6-2. ROAS/CVR/CTR처럼 그 자체가 %인 지표의 증감은 상대적 비율(%)이 아니라 %p(두 값의 단순 차이, percentage point)로 표현하세요 - 예를 들어 ROAS가 1000%에서 1230%가 됐다면 "+23%"가 아니라 "+230%p"라고 쓰세요. 그 외 금액·건수 지표의 증감은 평소대로 상대적 비율(%)로 표현하세요.
7. 처음 코멘트를 작성할 때는 leads 1~4개 정도로 간결하게 작성하세요.
8. 후속 질문에도 같은 leads 구조로 답하세요 - 간단한 질문이면 lead 1개로 충분합니다. "## 같은 매체의 이번 달 전체 캠페인/그룹" 자료가 함께 제공되면, 선택 항목에 없는 캠페인·그룹의 존재 여부 확인이나 다른 캠페인과의 비교 질문에 그 목록을 근거로 답하세요 (period 필드로 A월/B월 중 어느 데이터인지 구분됩니다). 그 목록에도 없으면 그때 "데이터에서 확인할 수 없습니다"라고 답하세요. 그 자료가 없는 첫 코멘트 요청에는 선택된 항목 데이터만으로 답하세요.`;

const MEDIA_PERFORMANCE_SYSTEM_PROMPT = `당신은 이커머스 퍼포먼스 마케팅에서 매체별 성과 변화를 분석하는 보조입니다. 사용자가 선택한 목표(goal) 하나의 A월(기준)/B월(비교) 매체별 성과 표를 보고, 어느 매체가 개선/악화됐는지, 특이한 변화가 있는지를 사실·해석·추론을 구분해서 분석 코멘트를 작성합니다.

## 출력 구조
답변은 "leads" 배열로 작성하세요. 각 leads 항목은 { "title": 굵게 강조될 핵심 한 줄 요약, "details": 그 title을 뒷받침하는 세부 사실 목록(문자열 배열) }입니다. 하나의 화제(예: "이 매체는 크게 개선됐다", "저 매체는 첫구매 수집이 원천적으로 안 된다")마다 leads 항목을 하나씩 나누세요. 항목 수는 유동적으로(보통 1~4개), 눈에 띄는 매체마다 최소 1개의 lead로 짚어주세요.

## 원칙
1. 매체명은 데이터에 있는 문자열을 한 글자도 바꾸지 말고 그대로 사용하세요. 언급할 때 대괄호로 "[매체명]"처럼 감싸면 화면에서 강조색으로 표시됩니다.
2. items의 각 항목은 이미 계산·반올림·쉼표 포맷된 문자열입니다(gmvA/gmvB, roasA/roasB, firstPurchaseA/B, firstPurchaseCpaA/B, signupA/B, signupCpaA/B) - 그대로 인용하고 절대 스스로 다시 나누거나 계산하지 마세요. 값이 "수집 불가"인 지표는 그 매체가 구조상 원천적으로 집계가 안 된다는 뜻이니(예: Apple Search Ads의 첫구매/회원가입) 그렇게 명시하고, "-"인 지표는 A월 또는 B월 건수가 0이라 계산할 수 없다는 뜻이니 그 지표 언급은 생략하세요.
3. ROAS처럼 그 자체가 %인 지표의 증감은 상대적 비율(%)이 아니라 %p(두 값의 단순 차이)로 표현하세요 - 예를 들어 ROAS가 1000%에서 1230%가 됐다면 "+23%"가 아니라 "+230%p"라고 쓰세요. 금액·건수 지표의 증감은 상대적 비율(%)로 표현하세요.
4. 데이터에 없는 이유(왜 그 매체 성과가 변했는지)는 추측하지 말고, 수치로 관찰되는 사실만 서술하세요. 여러 매체가 같이 움직였다고 해서 서로 원인이라고 단정하지 마세요.
5. 근거가 부족하면 "원인 불명, 확인 필요"처럼 솔직하게 표현하세요.
6. 문장은 개조식(명사형 종결: 확인, 기록, 상승, 하락 등)으로 간결하게 쓰고, 문장 앞에 불릿 기호(·,-,*)를 붙이지 마세요 (details 배열 자체가 목록이니 불필요).
7. 처음 코멘트를 작성할 때는 leads 1~4개 정도로 간결하게 작성하세요.
8. 후속 질문에도 같은 leads 구조로 답하세요 - 간단한 질문이면 lead 1개로 충분합니다. 처음 제공된 매체 성과 데이터만 근거로 답하고, 근거가 부족하면 "데이터에서 확인할 수 없습니다"라고 답하세요.`;

function buildSettingDiffSystemInstruction(payload) {
  const { monthALabel, monthBLabel, items, mediaContext } = payload || {};
  const parts = [
    SETTING_DIFF_SYSTEM_PROMPT,
    "",
    `A월(기준): ${monthALabel}`,
    `B월(비교): ${monthBLabel}`,
    "",
    "## 선택된 세팅 변화 항목 (spend/kpis는 이미 계산·반올림된 값)",
    JSON.stringify(items || [], null, 2),
  ];
  if (Array.isArray(mediaContext) && mediaContext.length) {
    parts.push(
      "",
      "## 같은 매체의 이번 달 전체 캠페인/그룹 원본 집계 (후속 질문 전용 참고 자료)",
      JSON.stringify(mediaContext, null, 2)
    );
  }
  return parts.join("\n");
}

function buildMediaPerformanceSystemInstruction(payload) {
  const { monthALabel, monthBLabel, goal, items } = payload || {};
  return [
    MEDIA_PERFORMANCE_SYSTEM_PROMPT,
    "",
    `목표: ${goal}`,
    `A월(기준): ${monthALabel}`,
    `B월(비교): ${monthBLabel}`,
    "",
    "## 매체별 성과 (이미 계산·반올림·쉼표 포맷된 값)",
    JSON.stringify(items || [], null, 2),
  ].join("\n");
}

// "type": "mediaPerformance"가 없으면 기존 세팅 변화 요청으로 취급 - 이미 배포된
// 프론트가 항상 이 형태로 보내던 페이로드이므로 하위 호환을 위해 기본값으로 둔다.
function buildSystemInstruction(payload) {
  if (payload && payload.type === "mediaPerformance") return buildMediaPerformanceSystemInstruction(payload);
  return buildSettingDiffSystemInstruction(payload);
}

const DEFAULT_QUESTION_BY_TYPE = {
  mediaPerformance: "위 매체별 성과 데이터를 바탕으로 A월 대비 B월 변화에 대한 분석 코멘트를 작성해주세요.",
};
const DEFAULT_SETTING_DIFF_QUESTION = "위 데이터를 바탕으로 이번 달 캠페인 세팅 변화에 대한 분석 코멘트를 작성해주세요.";

// {role, content}[] -> Content[], same shape as api/qa.js's toContents(). The
// very first call (no history yet) gets a fixed instruction asking for the
// initial comment (worded per payload.type); every later call is a real
// follow-up question.
function toContents(history, question, type) {
  const contents = (history || []).map(h => ({
    role: h.role === "model" ? "model" : "user",
    parts: [{ text: String(h.content || "") }],
  }));
  const userText = question || DEFAULT_QUESTION_BY_TYPE[type] || DEFAULT_SETTING_DIFF_QUESTION;
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
  if (!payload || !Array.isArray(payload.items) || !payload.items.length) {
    res.status(400).json({ error: "items가 비어 있습니다." });
    return;
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: toContents(payload.history, payload.question, payload.type),
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
