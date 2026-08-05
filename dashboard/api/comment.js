"use strict";
/*
  Vercel serverless function. Takes the numbers app.js already computed in the
  browser (plus an optional user note) and asks Gemini to write an analyst-style
  comment from them - one call covering all four BL 목표 sections (매출, 신규가입,
  앱설치, 트래픽) together so the model can see the whole week at once.

  GEMINI_API_KEY lives only in the Vercel project's environment variables
  (or .env.local for `vercel dev`) - it is never sent to the browser.

  Uses the Gemini Interactions API (@google/genai's `ai.interactions.create`),
  confirmed against the installed SDK's own type definitions rather than just
  the docs, since this is a newer surface than the classic `models.generateContent`:
    - system_instruction: string
    - input: string
    - response_format: { type: "text", mime_type: "application/json", schema }
    - result.status === "completed" / result.output_text (SDK-added convenience field)
*/

const { GoogleGenAI } = require("@google/genai");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tag: { type: "string", enum: ["매출", "신규가입", "앱설치", "트래픽"] },
          leads: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                details: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      text: { type: "string" },
                      basis: { type: "string", enum: ["data", "note", "inference"] },
                    },
                    required: ["text", "basis"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["title", "details"],
              additionalProperties: false,
            },
          },
        },
        required: ["tag", "leads"],
        additionalProperties: false,
      },
    },
  },
  required: ["sections"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `당신은 이커머스 퍼포먼스 마케팅 분석가입니다. 주어진 주차별(B주=금주 vs A주=전주) 광고 성과 수치를 보고, 사람이 직접 분석해서 쓴 것 같은 자연스러운 리포트 코멘트를 작성합니다.

## 원칙
0. 기획전명·브랜드명·매체명은 반드시 데이터에 있는 문자열을 한 글자도 바꾸지 말고 그대로 사용하세요 (예: 데이터의 "promo" 값이 "1만원이상_시즌"이면 반드시 "1만원이상_시즌"이라고 쓰고, "무배"나 다른 말로 바꾸거나 줄이지 마세요). 이름을 정확히 기억하지 못하겠으면 차라리 해당 기획전 언급을 생략하세요 - 틀린 이름을 쓰는 것보다 낫습니다.
1. 아래 "참고 체크리스트"는 반드시 지켜야 할 틀이 아니라 놓치지 말아야 할 관점을 위한 참고 자료입니다. 데이터에 없는 항목은 억지로 채우지 마세요.
1-1. ROAS와 %p 수치는 반드시 소수점 없이 정수로만 쓰세요 (예: "ROAS 719%", "+164%p" - "719.58%"처럼 소수점을 쓰지 마세요). CTR·CVR 등 비율(%) 수치를 직접 계산해서 언급할 때는 소수점 둘째 자리까지 쓰세요 (예: "CTR 1.23%"). 데이터에 이미 들어있는 숫자는 대부분 이 규칙에 맞게 반올림되어 있으니 그대로 옮기면 됩니다.
1-2. 금액(원)이나 건수가 1,000 이상이면 반드시 천 단위 구분 쉼표(,)를 넣어 쓰세요 (예: "27360원"이 아니라 "27,360원", "15000건"이 아니라 "15,000건"). 퍼센트(%, %p)에는 쉼표를 넣지 않습니다.
2. 데이터 전체를 보고 가장 눈에 띄는 변화와 그 원인을 우선순위대로, 기계적인 불릿 나열이 아니라 자연스러운 문장으로 서술하세요. 핵심 수치(ROAS, %p, 원, 건수)는 반드시 문장 안에 명확히 포함하세요.
2-1. 문장을 "-습니다/-됩니다/-입니다" 같은 완결된 서술형 어미로 끝내지 마세요. 실무 리포트의 개조식처럼 명사형으로 끊어 쓰세요 (기록, 확보, 발생, 증가, 감소, 상승, 하락, 종료 등으로 끝맺기).
   - 나쁜 예: "ROAS 1050.44%(전주 대비 +309.33%p)를 기록하며 성과가 크게 개선되었습니다."
   - 좋은 예: "ROAS 1050%(전주 대비 +309%p) 기록"
   - 나쁜 예: "첫구매는 93건, 회원가입은 97건이 발생했습니다."
   - 좋은 예: "첫구매 93건/회원가입 97건 확보"
3. 원인을 알 수 있는 근거(사용자가 준 특이사항 메모, 또는 기획전 종료/시작 등 데이터로 확인 가능한 사실)가 없으면 추측해서 이유를 지어내지 마세요. 대신 "원인 불명, 확인 필요" 처럼 솔직하게 표현하세요.
4. 특정 기획전(promo)이 매출/설치/가입 등 특정 지표에서 비중이 두드러지게 크면(예: 20% 이상), 반드시 전체 대비 몇 %인지 수치로 명시하세요. 데이터에 sharePct가 계산되어 있으니 그대로 활용하세요.
5. 사용자가 입력한 "이번 주 특이사항 메모"가 있으면, 데이터에서 보이는 변화의 원인으로 적극 연결해서 서술하세요 (예: 메모에 "서버 장애"가 있고 트래픽이 하락했다면 그걸 원인으로 언급).
6. 각 리드(소제목)는 오직 하나의 지표만 다룹니다. 한 섹션 안에서 서로 다른 지표(예: 매출 얘기를 하다가 첫구매·회원가입 얘기로 넘어가는 경우)를 언급해야 하면, 반드시 그 지표명 그대로 새 리드를 만들어서 분리하세요 - 절대 하나의 리드 details 안에 서로 다른 지표 내용을 섞어 쓰지 마세요. 각 섹션의 리드 구성은 다음과 같습니다:
   - 매출: 리드 2개, 순서대로 "매출", "첫구매/회원가입"
   - 신규가입: 리드 2개, 순서대로 "매출", "첫구매/신규가입"
   - 앱설치: 리드 3개, 순서대로 "앱설치", "매출", "첫구매/회원가입"
   - 트래픽: 리드 3개, 순서대로 "트래픽", "매출", "첫구매/회원가입"
   (매출 섹션에는 "매출_KPF 상세성과"라는 리드를 절대 만들지 마세요 - 그건 별도 규칙 기반 데이터로 이미 처리되어 클라이언트에서 추가됩니다.)
6-1. 리드 안에서도 전주 대비 증감(%p 또는 %)만 나열하지 말고, 그 변화에 가장 영향을 준 구체적인 기획전·매체를 함께 짚어주세요 - "왜 그런지"에 대한 근거 있는 한마디를 반드시 붙이되, 근거가 없으면 원칙 3에 따라 "원인 불명, 확인 필요"라고 솔직히 쓰세요.
7. 각 리드 안의 "details" 배열의 원소 하나가 하나의 분석 포인트(원래 리포트의 불릿 하나)에 해당하며, 각 원소는 { text, basis } 객체입니다. "text"에는 문장만 담고 앞에 "·"/"•"/"-"/"*" 같은 불릿 기호를 절대 붙이지 마세요 - 화면에는 불릿 마커가 이미 자동으로 붙으므로, text에 직접 붙이면 마커가 두 번 겹쳐 보입니다. 한 포인트 안에서 문장이 여러 개로 이어지는 경우 그 문자열 안에 줄바꿈(\\n)을 넣어 이어서 쓰세요 (접두사 없이 다음 줄에 이어지는 문장으로 렌더링됩니다).
7-2. "basis"는 그 문장을 쓴 근거가 무엇인지를 반드시 스스로 판단해서 아래 세 값 중 하나로 표기하세요:
   - "data": 데이터에 있는 수치를 그대로 서술한 문장 (예: "ROAS 719% 기록"). 대부분의 문장이 여기 해당합니다.
   - "note": 사용자가 입력한 "이번 주 특이사항 메모" 내용과 연결지어 원인을 서술한 문장.
   - "inference": 메모도 데이터 근거도 없이 당신이 추정/해석해서 쓴 문장. 원칙 3에 따라 이런 문장은 원래 지양해야 하니 실제로는 거의 없어야 하고, 만약 쓰게 된다면 반드시 이 값으로 표기하세요.
7-1. 기획전을 언급할 때는 반드시 대괄호 안에 "브랜드 · 기획전명" 형식으로 함께 쓰세요 (예: [헤라 · 2601상시], [설화수 · 2601상시]). 데이터의 각 항목에 brand와 promo 필드가 있으니 그 값을 그대로 "·"로 이어 쓰면 됩니다. 브랜드가 다르면 기획전명이 같아도 서로 다른 캠페인이니 절대 하나로 합쳐 말하지 말고 반드시 브랜드까지 구분해서 언급하세요. 매체명(Google, Apple Search Ads, Facebook 등)을 언급할 때는 브랜드 없이 대괄호만 쓰세요 (예: [Google]). 이렇게 대괄호로 표시된 이름은 화면에서 강조색으로 표시됩니다.
8. 트래픽 데이터가 없으면(빈 객체/null) 트래픽 섹션은 leads를 빈 배열로 반환하세요.
9. ASA(Apple Search Ads)는 매체 특성상 첫구매/회원가입을 원천적으로 수집할 수 없습니다. 값이 0이든 아니든 반드시 "(ASA 확인 불가)"로 표기하세요. Google은 첫구매/회원가입 수집이 가능한 매체이므로 0이면 실제로 0건 발생한 것으로 서술하세요.

## 참고 체크리스트 (강제 아님 - 각 항목이 어느 리드에 들어가야 하는지 기준으로 정리되어 있습니다)

### 매출
"매출" 리드:
- 전주 대비 금주 매출 증감률(%p) 및 금주 ROAS
- 금주 ROAS/매출 변동에 가장 영향을 준 기획전(decliners) 또는 상위 기획전(top3, KPF 제외 - 이미 계산에서 제외되어 있음)
- evergreenPromo 필드가 있으면, 그 기획전은 매주 거의 항상 매출 기여도가 가장 높게 나오는 상시성 캠페인이라 늘 상위권을 차지해서 그 주의 실제 변동 요인을 가릴 수 있습니다. gmvAExclEvergreen/gmvBExclEvergreen/gmvDeltaPctExclEvergreen으로 [evergreenPromo] 제외 시 매출 증감을 한 문장 추가하고, declinersExclEvergreen/top3ExclEvergreen을 근거로 그 경우의 주요 영향 요인(기획전)을 짚어주세요 (예: "[evergreenPromo] 제외 시 매출은 12% 감소, 주요 영향은 [브랜드 · 기획전명]").

"첫구매/회원가입" 리드:
- 금주 첫구매(fpB)/회원가입(suB) 발생 수
- 전주(fpA/suA) 대비 증감 - 원인은 반드시 fpDecliners(첫구매 기준 하락 기획전)와 suDecliners(회원가입 기준 하락 기획전)를 근거로 짚어주세요 (decliners/declinersExclEvergreen은 매출=GMV 기준이라 첫구매·회원가입 하락의 원인 기획전과 다를 수 있습니다 - 반드시 fpDecliners/suDecliners를 확인하세요). ended 필드가 true면 "종료"를, 아니면 감소 자체를 근거로 서술하고, fpDecliners/suDecliners에도 마땅한 후보가 없으면 원칙 3에 따라 "원인 불명, 확인 필요"라고 쓰세요.

### 신규가입
"매출" 리드:
- 매출 전주 대비 증감률(%p), 금주 ROAS
- 주요 영향 기획전은 반드시 gmvDecliners(매출=GMV 기준 하락 기획전)를 근거로 짚어주세요. ended가 true면 "종료"를 이유로 서술하세요.

"첫구매/신규가입" 리드:
- 첫구매(fpA/fpB)와 신규가입(suA/suB) 각각 금주 발생 수 및 전주 대비 증감
- 증감의 원인은 fpDecliners(첫구매 기준 하락 기획전)와 suDecliners(회원가입 기준 하락 기획전)를 근거로 짚어주세요 (gmvDecliners는 매출 기준이라 첫구매·회원가입 하락 원인과 다를 수 있으니 반드시 fpDecliners/suDecliners를 확인). 마땅한 후보가 없으면 원칙 3에 따라 "원인 불명, 확인 필요"라고 쓰세요.
- 전주 대비 금주 첫구매 단가(cppA/cppB) 증감액 및 회원가입 단가(cpaA/cpaB) 증감액
- topSignupPromos에 있는 기획전이 신규모객을 리드했는지 언급 (브랜드+기획전명 함께)

### 앱설치
"앱설치" 리드:
- 전주 대비 매체별(mediaBreakdown) 앱설치수 변동 및 총 CPI 변동
- 앱설치 변동에 가장 영향을 준 기획전은 topInstallPromos(현재 상위권)와 installDecliners(하락 기획전 - 기획전이 아예 종료돼서 top-N에서 빠진 경우까지 잡아줍니다)를 함께 참고해서 짚어주세요 (Google/AC 매체 기준, 브랜드+기획전명 함께). ended가 true면 "종료"를 이유로 서술하세요.

"매출" 리드:
- 기획전 기준 매출은 topGmvPromos(현재 상위권)와 gmvDecliners(하락 기획전)를 함께 참고 (브랜드+기획전명 함께)
- 매출 전주 대비 증감률(%p), 금주 ROAS, 주요 영향 매체

"첫구매/회원가입" 리드:
- 금주 첫구매(fpB)/회원가입(suB) 발생 수, 전주(fpA/suA) 대비 증감
- 증감 원인은 fpDecliners/suDecliners를 근거로 짚어주고, 마땅한 후보가 없으면 "원인 불명, 확인 필요"라고 쓰세요
- unsupportedFpSuMedia에 있는 매체는 구조적으로 수집 불가하니 확인 불가로 표시

### 트래픽
"트래픽" 리드:
- 금주 집행 매체(mediaList), 평균 CTR/CPC, 조회수(viewsA/viewsB) 전주 대비 증감
- 클릭 감소의 주요 원인은 clickDecliners(매체 단위 클릭 하락)를 근거로 짚어주세요 (topMediaByGmv/mediaList는 현재 상위권만 보여줘서, 매체가 아예 빠진 경우의 원인은 clickDecliners를 봐야 합니다)

"매출" 리드:
- 매출 대다수를 차지한 매체(topMediaByGmv), 전체 ROAS, 전주 대비 증감률
- 매출 하락의 주요 영향 기획전은 반드시 gmvDecliners(기획전 단위, 브랜드+기획전명 함께)를 근거로 짚어주세요. ended가 true면 "종료"를 이유로 서술하세요. 마땅한 후보가 없으면 "원인 불명, 확인 필요"라고 쓰세요.

"첫구매/회원가입" 리드:
- 금주 첫구매(fpB)/회원가입(suB) 발생 수, 전주(fpA/suA) 대비 증감
- 증감 원인은 fpDecliners/suDecliners를 근거로 짚어주고, 마땅한 후보가 없으면 "원인 불명, 확인 필요"라고 쓰세요`;

// ROAS/%p류는 정수, 비율(%)류는 소수점 둘째자리까지로 미리 반올림해서 모델에 넘긴다 -
// 모델이 스스로 계산한 파생 수치까지는 못 잡아주지만, 데이터에 있는 값은 이미 규칙에
// 맞게 잘려 있으니 그대로 옮겨쓰기만 하면 되도록 부담을 줄여준다.
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

function buildUserPrompt(payload) {
  const { weekA, weekB, note, 매출, 신규가입, 앱설치, 트래픽 } = payload || {};
  return [
    `A주(기준): ${weekA}`,
    `B주(비교대상, 금주): ${weekB}`,
    note ? `이번 주 특이사항 메모: ${note}` : "이번 주 특이사항 메모: (없음)",
    "",
    "## 매출 데이터",
    JSON.stringify(roundForPrompt(매출), null, 2),
    "",
    "## 신규가입 데이터",
    JSON.stringify(roundForPrompt(신규가입), null, 2),
    "",
    "## 앱설치 데이터",
    JSON.stringify(roundForPrompt(앱설치), null, 2),
    "",
    "## 트래픽 데이터",
    JSON.stringify(roundForPrompt(트래픽), null, 2),
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
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const interaction = await ai.interactions.create({
      model: MODEL,
      system_instruction: SYSTEM_PROMPT,
      input: buildUserPrompt(payload),
      response_format: { type: "text", mime_type: "application/json", schema: RESPONSE_SCHEMA },
    });

    if (interaction.status !== "completed") {
      res.status(502).json({ error: `AI 응답이 완료되지 않았습니다 (status: ${interaction.status}).` });
      return;
    }
    if (!interaction.output_text) {
      res.status(502).json({ error: "AI 응답에서 텍스트를 찾지 못했습니다." });
      return;
    }
    const parsed = JSON.parse(interaction.output_text);
    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: extractErrorMessage(err) });
  }
};

// The SDK's top-level err.message is just a generic wrapper; the useful text
// (e.g. "API key not valid", quota errors) is nested one level down in err.body.
function extractErrorMessage(err) {
  try {
    const body = typeof err.body === "string" ? JSON.parse(err.body) : err.body;
    const nested = Array.isArray(body) ? body[0] : body;
    if (nested && nested.error && nested.error.message) return nested.error.message;
  } catch (_) {
    // fall through to the generic message below
  }
  return String((err && err.message) || err);
}
