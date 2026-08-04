"use strict";
/*
  Vercel serverless function backing the "완료 시 Slack 알림" checkbox. Posts the
  finished AI comment (same plain text the "코멘트 복사" button copies) to a fixed
  Slack channel via a bot token, so someone can start an analysis and step away
  without needing to keep the tab open to know when it's done.

  SLACK_BOT_TOKEN lives only in the server environment (.env.local locally, a
  Vercel project env var once deployed) - the browser never sees it, same
  reasoning as GEMINI_API_KEY. The channel isn't a secret, so it's a plain
  constant here rather than another env var to manage.
*/

const CHANNEL_ID = "C08812X9QG0";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!process.env.SLACK_BOT_TOKEN) {
    res.status(500).json({ error: "SLACK_BOT_TOKEN이 서버에 설정되어 있지 않습니다." });
    return;
  }
  try {
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const text = (payload && payload.text) || "";
    if (!text.trim()) {
      res.status(400).json({ error: "text가 비어 있습니다." });
      return;
    }

    const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: CHANNEL_ID,
        text: `*코멘트 작성이 완료되었습니다*\n\n\`\`\`\n${text}\n\`\`\``,
      }),
    });
    const slackBody = await slackRes.json();
    // Slack's Web API returns HTTP 200 even on failure - the real success flag is `ok`.
    if (!slackBody.ok) {
      res.status(502).json({ error: `Slack API 오류: ${slackBody.error || "unknown"}` });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
