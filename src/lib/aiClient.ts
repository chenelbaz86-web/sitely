// src/lib/aiClient.ts
import { anthropic } from "@ai-sdk/anthropic";
import { streamText, generateText, type CoreMessage } from "ai";
import Bottleneck from "bottleneck";

// 1) מודל עם ITPM גבוה יותר
export const MODEL = anthropic("claude-3-5-haiku-latest");

// 2) תקרת פלט שמרנית (OTPM) — אפשר גם דרך ENV
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 800);

// 3) הערכת טוקנים גסה (~1 טוקן ≈ 4 תווים)
function estimateTokens(str: string) {
  return Math.ceil((str?.length || 0) / 4);
}

// 4) תקציב ITPM לפי מודל (התאימי אם תחליפי מודל)
const ITPM_BY_MODEL: Record<string, number> = {
  "claude-3-5-haiku-latest": 50_000,
  "claude-3-5-sonnet-latest": 20_000,
  "claude-4-sonnet-20250514": 30_000,
};
const ITPM_LIMIT = ITPM_BY_MODEL["claude-3-5-haiku-latest"] ?? 20_000;

// לעבוד על 90% מהתקרה כדי לא להיתקע על בורסטים
const SAFETY = 0.9;
const ITPM_BUDGET = Math.floor(ITPM_LIMIT * SAFETY);

// 5) חלון דקה לניהול תקציב
let minuteStart = Date.now();
let usedThisMinute = 0;

function resetWindowIfNeeded() {
  const now = Date.now();
  if (now - minuteStart >= 60_000) {
    minuteStart = now;
    usedThisMinute = 0;
  }
}

async function waitForBudget(need: number) {
  for (;;) {
    resetWindowIfNeeded();
    if (usedThisMinute + need <= ITPM_BUDGET) {
      usedThisMinute += need;
      return;
    }
    const msLeft = 60_000 - (Date.now() - minuteStart);
    await new Promise((r) => setTimeout(r, Math.max(msLeft, 200)));
  }
}

// 6) תור מרכזי + ריטריי על 429
const limiter = new Bottleneck({
  minTime: 80,               // רווח קטן בין בקשות
  reservoir: 1000,           // מרסן בורסטים (אופציונלי)
  reservoirRefreshInterval: 60_000,
  reservoirRefreshAmount: 1000,
});

async function withRetry<T>(fn: () => Promise<T>) {
  let delay = 400;
  for (let i = 0; i < 5; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.statusCode || err?.status;
      const is429 =
        status === 429 ||
        /rate[_\s-]?limit/i.test(String(err?.message ?? err));

      if (!is429 || i === 4) throw err;

      // לכבד Retry-After אם קיים
      const retryAfterHeader =
        err?.responseHeaders?.["retry-after"] ??
        err?.response?.headers?.["retry-after"];
      const retryAfterMs = Number(retryAfterHeader) * 1000;

      const waitMs =
        !Number.isNaN(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : delay;

      await new Promise((r) => setTimeout(r, waitMs));
      delay = Math.min(delay * 2, 8000);
    }
  }
  throw new Error("unreachable");
}

// 7) קיצור היסטוריית צ'אט: שומרים רק 2–3 הודעות אחרונות
function trimHistory(messages: CoreMessage[], keep = 3): CoreMessage[] {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const convo = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const tail = convo.slice(-keep);
  return [...systemMsgs, ...tail];
}

// 8) פונקציות לשימוש מהאפליקציה
export async function askText(params: {
  system?: string;
  messages: CoreMessage[];
  stream?: boolean;
}) {
  // System קצר כדי לא לבזבז ITPM
  const system = (params.system ?? "ענה תמציתית ואל תחזור על השאלה.").slice(0, 400);

  // לצמצם היסטוריה
  const messages = trimHistory(params.messages, 3);

  // הערכת ITPM נדרשת לבקשה
  const inputBlob = system + JSON.stringify(messages);
  const estimatedInput = estimateTokens(inputBlob);

  // להמתין אם עברנו תקציב לדקה
  await waitForBudget(estimatedInput);

  const run = async () => {
    if (params.stream) {
      return await streamText({
        model: MODEL,
        system,
        messages,
        maxTokens: MAX_OUTPUT_TOKENS,
      });
    }
    return await generateText({
      model: MODEL,
      system,
      messages,
      maxTokens: MAX_OUTPUT_TOKENS,
    });
  };

  // להריץ דרך התור + ריטריי
  return await limiter.schedule(() => withRetry(run));
}

// 9) הגנה בסיסית מ-unhandledRejection כדי לא להפיל את השרת
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});
