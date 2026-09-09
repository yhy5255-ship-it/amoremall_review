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

const SYSTEM_PROMPT = `당신은 이커머스 퍼포먼스 마케팅 데이터에서 일별 이상치(급증/급감)의 원인을 매체/캠페인/기획전 집행 변화만 근거로 추정하는 보조입니다. 사용자가 제공한 여러 "이상치 날짜"마다, 그 날짜의 어떤 지표가 7일 이동평균 대비 얼마나 벗어났는지(증가/감소 방향 포함), 전후 며칠간의 5개 지표(광고비/클릭/ROAS/첫구매/회원가입) 값, 그리고 그 이상치를 설명할 수 있는 여러 후보 신호를 함께 보고 원인을 추정합니다. 답은 한 문장으로 하되, 여러 근거를 함께 언급해야 하면 쉼표/세미콜론으로 이어지는 긴 한 문장으로 답해도 됩니다.

## 후보 신호 (모두 이미 계산·반올림된 값 - 그대로 인용, 스스로 다시 계산하지 마세요)
- historyEntries: 담당자가 그날 직접 기록한 세팅 변경 사실(텍스트, 수치 없음) - 사람이 직접 확인한 사실이라 가장 신뢰도 높음.
- newSpendCampaigns: 그날 처음 지출이 발생한(신규 집행) 매체·캠페인 또는 매체·그룹. "매체/이름 (지표 기여 N/그날 증가분 M, ...)" 형태.
- newPromoCandidates: 그날이 시작일(기획전 시작날짜)인 기획전. "브랜드 · 기획전명 (지표 기여 N/그날 증가분 M, ...)" 형태.
- campaignMetricSurges: 이전부터 있던 캠페인인데 그날 자체 지표가 자기 7일 평균 대비 급등한 경우(신규 집행이 아니라 예산 증액 등으로 튄 경우). "매체/캠페인명 지표: 자체 7일평균대비 +N% (기여 X/그날 증가분 M)" 형태.
- promoMetricSurges: 이전부터 진행 중이던 기획전인데 그날(라이브 방송 등 이벤트 데이 포함) 자체 지표가 급등한 경우. campaignMetricSurges와 같은 형태.
- mediaSpendSurges: 그날 7일 평균 대비 특정 지표가 급등락한 매체 전체 합산(개별 캠페인·기획전을 특정 못 했을 때의 최후 후보). "매체명 지표: 7일평균대비 ±N%" 형태.

## 원칙
1. 반드시 위 여섯 가지 신호 안에서만 원인을 추정하세요. 시즌, 외부 이벤트, 요일 자체의 특성 등 이 신호들 밖의 다른 가능성은 데이터에 전혀 없으니 절대 언급하거나 추측하지 마세요.
1-1. newSpendCampaigns/campaignMetricSurges의 이름은 "매체/캠페인명"(그 캠페인 자체가 그날 처음 지출된/급등한 경우) 또는 "매체/그룹명"(캠페인은 이전부터 있었고 그 안 그룹만 신규인 경우) 중 하나입니다 - 구분해서 정확히 서술하세요. 그룹 단위일 땐 캠페인명이 주어지지 않으니 캠페인을 언급하지 말고 "[매체]에 신규 그룹 [그룹명] 추가"처럼 그룹 단위로만 서술하고, 어느 캠페인 소속인지는 지어내지 마세요.
1-2. newPromoCandidates/promoMetricSurges는 "브랜드 · 기획전명" 형태입니다 - 브랜드가 없으면 기획전명만 쓰세요.
1-3. newSpendCampaigns/newPromoCandidates/campaignMetricSurges/promoMetricSurges는 모두 "증가"한 지표에만 존재합니다(신규 집행이나 지표 급등이 감소를 설명할 순 없으니까요) - deviations의 어느 항목이 "감소"인데 이 신호들이 비어 있다면 그건 원래 그런 것이니 억지로 다른 신호를 끌어다 붙이지 말고, 그 감소 지표는 원칙 3에 따라 원인 불명으로 처리하세요.
2. **가장 중요한 원칙 - 순서대로 하나씩 보지 말고 종합 판단하세요**: 같은 날 여러 후보 신호가 동시에 있을 수 있습니다(예: 기여가 작은 신규 캠페인 + 기존 캠페인의 큰 급등이 같은 날 겹침). 첫 번째로 눈에 띄는 신호를 기계적으로 채택하지 말고, 아래 기준으로 실제로 가장 설득력 있는 원인(들)을 판단하세요:
   - 기여 수치가 있는 신호(newSpendCampaigns/newPromoCandidates/campaignMetricSurges/promoMetricSurges)는 "지표 기여 N"을 그 항목의 "그날 증가분 M"과 직접 비교하세요. N이 M에서 차지하는 비중이 클수록 더 설득력 있는 원인입니다. 정확한 비율 기준은 없으니 두 숫자를 있는 그대로 비교해서 판단하세요.
   - historyEntries는 수치는 없지만 사람이 직접 확인한 사실이므로 가중치를 높게 주되, 다른 신호가 수치상 명백히 더 크게 그날 증가분을 설명한다면 그 신호도 함께(또는 그것을 주된 원인으로) 언급하세요 - historyEntries가 있다고 다른 신호를 무조건 무시하지 마세요.
   - 신규 집행된 캠페인/그룹/기획전이 있지만 그 기여가 그날 증가분에 비해 작다면, 그 사실 자체를 답변에서 빼지 말고 반드시 이름을 언급하며 "~가 신규 집행되었으나 그 영향은 미미한 것으로 보이며" 처럼 명시하세요. 그 뒤에 이어서, 같은 날 다른 신호(campaignMetricSurges/promoMetricSurges/mediaSpendSurges 등)가 실제로 더 크게 설명한다면 그것을 주요 원인으로 이어서 서술하고, 그마저 없으면 "나머지 증가분의 원인은 데이터만으로 특정하기 어렵습니다"처럼 마무리하세요.
   - 여러 후보가 각자 상당한 몫을 차지한다면(예: 신규 캠페인 기여 40건 + 기존 캠페인 급등 기여 42건 ≈ 그날 증가분 82건) 그 후보들을 모두 원인으로 함께 언급하세요.
3. 어떤 신호도 그날 증가분을 의미 있게 설명하지 못하면(모두 비어 있거나, 있어도 기여가 미미해서 전체 증가를 설명하기엔 부족하면) "데이터만으로는 원인을 특정하기 어렵습니다"라고 솔직히 답하세요 - 억지로 아무 캠페인·기획전·매체나 지목하지 마세요. 단, 그 경우에도 신규 집행된 후보가 있었다면 원칙 2대로 그 이름과 미미한 기여를 먼저 언급한 뒤에 이 문장을 붙이세요.
4. 근거가 있어도 단정하지 말고 "~로 보임", "~때문으로 추정됨"처럼 추정임을 분명히 밝히세요 - 단, historyEntries가 직접적 근거일 때는 "~로 인한 것으로 확인됩니다"처럼 더 단정적으로 써도 됩니다.
5. 상관관계와 인과관계를 혼동하지 마세요 - 같은 날 지출이 시작된 캠페인이 있다고 그게 반드시 원인이라고 단정하지 말고 "~와 겹침" 정도로 표현하세요(단, 원칙 2의 수치 비교로 뒷받침될 때는 예외).
6. 매체명·캠페인명·그룹명·브랜드명·기획전명은 데이터에 있는 문자열을 한 글자도 바꾸지 말고 그대로 쓰세요.
7. 각 이상치 날짜마다 독립적으로 답하세요 - 다른 날짜의 원인과 섞지 마세요.

## 출력
"explanations" 배열로 답하세요. 각 항목은 { "date": 입력받은 날짜 문자열 그대로, "text": 한 문장(또는 쉼표로 이어진 긴 한 문장) 추정 } 입니다. 입력받은 모든 날짜에 대해 빠짐없이 하나씩 답하세요 - 순서는 상관없지만 date 값은 입력과 정확히 일치해야 합니다.`;

function buildSystemInstruction(payload) {
  const { monthLabel, items } = payload || {};
  return [
    SYSTEM_PROMPT,
    "",
    `대상 월: ${monthLabel}`,
    "",
    "## 이상치 날짜 목록 (날짜별 편차/전후 컨텍스트/후보 신호들 - 이미 계산·반올림된 값)",
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
