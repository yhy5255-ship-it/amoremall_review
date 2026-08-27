"use strict";
/*
  Vercel serverless function backing the monthly review's "전체 일별 흐름" section -
  a ONE-SENTENCE cause guess per detected anomaly day. Batch-requested once right
  after the chart renders (app.js's fetchMonthlyTrendCauses), never per-hover - the
  tooltip just reads the cached result. Same fact/inference discipline as
  api/qa.js's SYSTEM_PROMPT, scoped down to "here's one day's deviation + nearby
  context, guess in one sentence or say you can't". No follow-up chat here (that's
  api/monthly-trend-comment.js, for the section's overall comment instead).
*/

const { GoogleGenAI } = require("@google/genai");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    explanations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          text: { type: "string" },
        },
        required: ["date", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["explanations"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `당신은 이커머스 퍼포먼스 마케팅 데이터에서 일별 이상치(급증/급감)의 원인을 매체/캠페인 집행 변화만 근거로 추정하는 보조입니다. 사용자가 제공한 여러 "이상치 날짜"마다, 그 날짜의 어떤 지표가 7일 이동평균 대비 얼마나 벗어났는지, 전후 며칠간의 5개 지표(광고비/클릭/ROAS/첫구매/회원가입) 값, 그날 처음 지출이 발생한(신규 집행) 매체·캠페인 또는 매체·그룹, 그날 7일 평균 대비 지출이 크게 오르내린 매체, 요일 정보만 보고 딱 한 문장으로 원인을 추정합니다.

## 원칙
1. 반드시 제공된 두 가지 신호 - (a) newSpendCampaigns, (b) mediaSpendSurges(그날 7일 평균 대비 지출이 급등락한 매체) - 안에서만 원인을 추정하세요. 기획전, 시즌, 외부 이벤트, 요일 자체의 특성 등 이 두 신호 밖의 다른 가능성은 데이터에 전혀 없으니 절대 언급하거나 추측하지 마세요.
1-1. newSpendCampaigns의 각 항목은 "매체/이름" 형태이고, 이름 부분이 두 가지 의미 중 하나입니다 - 구분해서 정확히 서술하세요:
   - 그 캠페인 자체가 그날 처음 지출이 발생한 경우 (기존 캠페인이 없었다가 완전히 새로 만든 캠페인): "매체/캠페인명" - 이때는 "새로 만든 [매체] 캠페인 [캠페인명]"처럼 캠페인 단위로 서술하세요.
   - 캠페인은 이전부터 있었고 그 안에 그룹만 새로 생긴 경우: "매체/그룹명" - 이때는 캠페인명이 주어지지 않으니 캠페인을 언급하지 말고 "[매체]에 신규 그룹 [그룹명] 추가"처럼 그룹 단위로만 서술하세요. 어느 캠페인 소속인지는 데이터에 없으니 지어내지 마세요.
2. newSpendCampaigns에 항목이 있으면 그것부터 원인으로 제시하세요 (새로 지출이 시작된 캠페인/그룹이 가장 직접적인 신호입니다). newSpendCampaigns가 비어 있으면 mediaSpendSurges 중 편차가 가장 큰 매체를 원인으로 제시하세요.
3. 두 신호가 모두 비어 있거나, 있어도 이상치 지표의 방향과 앞뒤가 안 맞아 신호가 약하면 "데이터만으로는 원인을 특정하기 어렵습니다"라고 솔직히 답하세요 - 억지로 아무 캠페인이나 매체를 지목하지 마세요.
4. 근거가 있어도 단정하지 말고 "~로 보임", "~때문으로 추정됨"처럼 추정임을 분명히 밝히세요.
5. 상관관계와 인과관계를 혼동하지 마세요 - 같은 날 지출이 시작된 캠페인이 있다고 그게 반드시 원인이라고 단정하지 말고 "~와 겹침" 정도로 표현하세요.
6. 반드시 한 문장으로 간결하게 답하세요. 매체명·캠페인명·그룹명은 데이터에 있는 문자열을 한 글자도 바꾸지 말고 그대로 쓰세요.
7. 각 이상치 날짜마다 독립적으로 답하세요 - 다른 날짜의 원인과 섞지 마세요.

## 출력
"explanations" 배열로 답하세요. 각 항목은 { "date": 입력받은 날짜 문자열 그대로, "text": 한 문장 추정 } 입니다. 입력받은 모든 날짜에 대해 빠짐없이 하나씩 답하세요 - 순서는 상관없지만 date 값은 입력과 정확히 일치해야 합니다.`;

function buildSystemInstruction(payload) {
  const { monthLabel, items } = payload || {};
  return [
    SYSTEM_PROMPT,
    "",
    `대상 월: ${monthLabel}`,
    "",
    "## 이상치 날짜 목록 (날짜별 편차/전후 컨텍스트/신규 집행·매체 지출 급등락 - 이미 계산·반올림된 값)",
    JSON.stringify(items || [], null, 2),
  ].join("\n");
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
      contents: [{ role: "user", parts: [{ text: "위 이상치 날짜들 각각에 대해 원인을 한 문장씩 추정해주세요." }] }],
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
