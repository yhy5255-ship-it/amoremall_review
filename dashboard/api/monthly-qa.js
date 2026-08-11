"use strict";
/*
  Vercel serverless function backing the monthly review's "AI에게 물어보기" side panel.
  Same intent as api/qa.js (free-form Q&A grounded in the loaded data, not just the
  pre-computed report numbers) but simpler: the monthly A/B pool is already month-
  aggregated (a few hundred rows at most), so unlike api/qa.js this skips keyword-based
  scoping and context caching entirely and just resends everything every turn via
  classic multi-turn generateContent - the same simplification api/monthly-comment.js
  and api/monthly-promo-comment.js already made for the same reason.
*/

const { GoogleGenAI } = require("@google/genai");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
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
    chartData: {
      type: "object",
      nullable: true,
      properties: {
        type: { type: "string", enum: ["bar", "line", "doughnut"] },
        labels: { type: "array", items: { type: "string" } },
        datasets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              data: { type: "array", items: { type: "number" } },
            },
            required: ["label", "data"],
            additionalProperties: false,
          },
        },
      },
      required: ["type", "labels", "datasets"],
      additionalProperties: false,
    },
  },
  required: ["answer", "table", "chartData"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `당신은 이커머스 퍼포먼스 마케팅 데이터를 근거로 질문에 답하는 분석 보조입니다. 사용자가 대시보드에 로드된 월간 리뷰(A월=기준, B월=비교)의 원본 집계 데이터를 보고 자유롭게 질문하면, 아래 원칙에 따라 답합니다.

## 원칙
0. 기획전명·브랜드명·매체명·캠페인명은 반드시 데이터에 있는 문자열을 한 글자도 바꾸지 말고 그대로 사용하세요. 정확히 기억나지 않으면 차라리 해당 항목 언급을 생략하세요. 서로 다른 브랜드가 같은 기획전명을 쓸 수 있으니, 특정 기획전을 언급할 때는 가능하면 "브랜드 · 기획전명" 형태로 함께 쓰세요.
1. 사실과 해석 구분: 답변 안에서 "데이터에 나온 사실"과 "그로부터의 해석/추론/가능성"을 명확히 구분해서 서술하세요. 근거 없는 원인·의도·감정·미래 결과를 추정하지 마세요.
2. 상관관계 ≠ 인과관계: 두 지표가 같이 움직였다고 해서 하나가 다른 하나의 원인이라고 단정하지 마세요.
3. 불확실성·데이터 부족: 주어진 데이터로 답할 근거가 부족하면 "모릅니다"라고 명확히 답하세요. 지금 로드된 A/B월 범위를 벗어난 질문이면 억지로 답하지 말고 현재 데이터의 범위(월)를 안내하세요.
4. "총/전체/합계" 같이 목표(goal)별 전체 합계를 묻는 질문에는 반드시 "totals" 필드 값을 그대로 인용하세요 - "groups"의 개별 행을 직접 더해서 답하지 마세요(기획전이 여러 개로 쪼개져 있어 암산하면 틀리기 쉽습니다). totals에 없는 조합을 물어보면 "모릅니다"라고 답하세요.
5. 숫자를 언급할 때 ROAS·%p는 정수로, 그 외 비율(%)은 소수점 둘째 자리까지로 표현하세요. 금액(원)이나 건수가 1,000 이상이면 반드시 천 단위 구분 쉼표(,)를 넣어 쓰세요 (예: "27360원"이 아니라 "27,360원") - 이 데이터의 숫자는 전부 쉼표 없는 원본값이니 직접 넣어야 합니다.
5-1. roas/cvr/ctr처럼 그 자체가 %인 지표의 A월 대비 B월 증감은 상대적 비율(%)이 아니라 %p(두 값의 단순 차이)로 표현하세요 - 예를 들어 ROAS가 1000%에서 1230%가 됐다면 "+23%"가 아니라 "+230%p"라고 쓰세요.
6. 답변은 실무자에게 말하듯 자연스러운 대화체 문단으로, 불필요하게 길게 늘이지 말고 핵심만 2~6문장으로 답하세요.
7. 질문이 여러 기획전/매체/캠페인을 비교하는 성격이면 "table"에 근거 수치를 표로 정리하세요 (한 번에 20행 이하). 표로 정리할 게 없으면 "table"은 반드시 null로 두세요.
8. 질문이 추세(주별/기간별 변화)나 여러 항목의 크기 비교를 보여주면 이해가 쉬운 경우, "chartData"를 채우세요 - type은 "bar"(비교)/"line"(추세)/"doughnut"(비중) 중 하나, labels는 x축 또는 항목명, datasets는 계열별 {label, data} 배열입니다. 단일 값 질문이거나 시각화할 게 없으면 "chartData"는 반드시 null로 두세요. chartData에 넣는 숫자도 원칙 5의 쉼표 규칙과 무관하게(차트는 숫자 그대로) 원본값을 쓰세요.
9. "## 참고용 과거 리뷰 자료" 섹션이 함께 제공되면, 사람이 직접 작성한 과거 월간 리뷰 시트 내용입니다 - 이번 A/B월의 totals/groups/campaignGroups와는 별개의 자료이니 섞어서 계산하지 말고, 필요하면 어느 자료(이번 분석 데이터 vs 과거 리뷰 자료)에 근거한 답변인지 구분해서 서술하세요. 그 섹션이 없으면 이 규칙은 무시하세요.

## 데이터 안내
"totals"는 목표(goal)별로 이미 계산된 A월/B월 합계입니다 (spend/gmv/firstPurchase/signup/install, 각각 A/B 접미사). "groups"는 채널·목표·매체·브랜드·기획전 단위 월간 집계이고, 각 행의 "period" 필드가 "A" 또는 "B"를 나타냅니다. "campaignGroups"는 매체·캠페인·광고그룹 단위 월간 집계입니다 (period 필드 동일) - 캠페인/광고그룹 세팅 관련 질문에 쓰세요. 모든 데이터는 안내된 A월/B월 범위로 한정되어 있습니다.`;

function buildSystemInstruction(payload) {
  const { monthALabel, monthBLabel, totals, groups, campaignGroups, reference } = payload || {};
  const parts = [
    SYSTEM_PROMPT,
    "",
    `A월(기준): ${monthALabel}`,
    `B월(비교): ${monthBLabel}`,
    "",
    "## totals (목표별 A/B월 합계)",
    JSON.stringify(totals || {}, null, 2),
    "",
    "## groups (채널·목표·매체·브랜드·기획전 단위 월간 집계)",
    JSON.stringify(groups || [], null, 2),
    "",
    "## campaignGroups (매체·캠페인·광고그룹 단위 월간 집계)",
    JSON.stringify(campaignGroups || [], null, 2),
  ];
  if (reference && reference.content) {
    parts.push("", `## 참고용 과거 리뷰 자료 (${reference.label || ""})`, reference.content);
  }
  return parts.join("\n");
}

// {role, content}[] -> Content[], same shape as api/qa.js's toContents().
function toContents(history, question) {
  const contents = (history || []).map(h => ({
    role: h.role === "model" ? "model" : "user",
    parts: [{ text: String(h.content || "") }],
  }));
  contents.push({ role: "user", parts: [{ text: String(question || "") }] });
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
  if (!payload || !payload.question) {
    res.status(400).json({ error: "question이 비어 있습니다." });
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
