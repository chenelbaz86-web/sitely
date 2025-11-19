// src/lib/internal/stream-manager.ts

import { UIMessage } from "ai";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { redis, redisPublisher } from "./redis";
import { AIService } from "./ai-service";
import { Agent } from "@mastra/core/agent";
import { FreestyleDevServerFilesystem } from "freestyle-sandboxes";
import Bottleneck from "bottleneck";

// ================================
// Rate Limit Guard (ITPM Budget + Queue + Retry)
// ================================

// אומדן גס: ~טוקן לכל 4 תווים
function estimateTokens(str: string) {
  return Math.ceil((str?.length || 0) / 4);
}

// מפה של ITPM לפי מודל (ניתן להרחיב/לעדכן לפי המסמכים של Anthropic)
const MODEL_ITPM: Record<string, number> = {
  "claude-3-5-haiku-latest": 50_000,
  "claude-3-5-sonnet-latest": 20_000,
  "claude-4-sonnet-20250514": 30_000,
};

// המודל הנוכחי לקביעת התקציב לדקה (לא מחליף את בחירת המודל ב-agent,
// רק משמש לניהול ה-ITPM Budget כאן)
const CURRENT_MODEL =
  process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";

const ITPM_LIMIT = MODEL_ITPM[CURRENT_MODEL] ?? 20_000;

// לעבוד מעט מתחת לתקרה כדי לא להתנגש בבורסטים
const SAFETY = 0.9;
const ITPM_BUDGET = Math.floor(ITPM_LIMIT * SAFETY);

// חלון דקה
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

// תור מרכזי למנוע בורסטים של בקשות במקביל
const limiter = new Bottleneck({
  minTime: 80, // רווח מינימלי בין בקשות
  reservoir: 1000, // מצמצם בורסטים; ניתן לכוונן
  reservoirRefreshInterval: 60_000,
  reservoirRefreshAmount: 1000,
});

// ריטריי חכם על 429 + כיבוד Retry-After אם קיים
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

// ================================
// Resumable stream infra (כמו שהיה)
// ================================

const streamContext = createResumableStreamContext({
  waitUntil: after,
});

export interface StreamState {
  state: string | null;
}

export interface StreamResponse {
  response(): Response;
}

export interface StreamInfo {
  readableStream(): Promise<ReadableStream<string>>;
  response(): Promise<Response>;
}

/**
 * Get the current stream state for an app
 */
export async function getStreamState(appId: string): Promise<StreamState> {
  const state = await redisPublisher.get(`app:${appId}:stream-state`);
  return { state };
}

/**
 * Check if a stream is currently running for an app
 */
export async function isStreamRunning(appId: string): Promise<boolean> {
  const state = await redisPublisher.get(`app:${appId}:stream-state`);
  return state === "running";
}

/**
 * Stop a running stream for an app
 */
export async function stopStream(appId: string): Promise<void> {
  await redisPublisher.publish(
    `events:${appId}`,
    JSON.stringify({ type: "abort-stream" })
  );
  await redisPublisher.del(`app:${appId}:stream-state`);
}

/**
 * Wait for a stream to stop (with timeout)
 */
export async function waitForStreamToStop(
  appId: string,
  maxAttempts: number = 60
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const state = await redisPublisher.get(`app:${appId}:stream-state`);
    if (!state) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/**
 * Clear the stream state for an app
 */
export async function clearStreamState(appId: string): Promise<void> {
  await redisPublisher.del(`app:${appId}:stream-state`);
}

/**
 * Get an existing stream for an app
 */
export async function getStream(appId: string): Promise<StreamInfo | null> {
  const hasStream = await streamContext.hasExistingStream(appId);
  if (hasStream === true) {
    return {
      async readableStream() {
        const stream = await streamContext.resumeExistingStream(appId);
        if (!stream) {
          throw new Error("Failed to resume existing stream");
        }
        return stream;
      },
      async response() {
        const resumableStream = await streamContext.resumeExistingStream(appId);
        if (!resumableStream) {
          throw new Error("Failed to resume existing stream");
        }
        return new Response(resumableStream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-vercel-ai-ui-message-stream": "v1",
            "x-accel-buffering": "no",
          },
        });
      },
    };
  }
  return null;
}

/**
 * Set up a new stream for an app
 */
export async function setStream(
  appId: string,
  prompt: UIMessage,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: any
): Promise<StreamResponse> {
  if (!stream.toUIMessageStreamResponse) {
    console.error("Stream missing toUIMessageStreamResponse method!");
    throw new Error("Stream missing required toUIMessageStreamResponse method");
  }

  const responseBody = stream.toUIMessageStreamResponse().body;

  if (!responseBody) {
    console.error("Response body is undefined!");
    throw new Error(
      "Error creating resumable stream: response body is undefined"
    );
  }

  await redisPublisher.set(`app:${appId}:stream-state`, "running", {
    EX: 15,
  });

  const resumableStream = await streamContext.createNewResumableStream(
    appId,
    () => {
      return responseBody.pipeThrough(
        new TextDecoderStream()
      ) as ReadableStream<string>;
    }
  );

  if (!resumableStream) {
    console.error("Failed to create resumable stream");
    throw new Error("Failed to create resumable stream");
  }

  return {
    response() {
      // Set up abort callback directly since this is a synchronous context
      redis.subscribe(`events:${appId}`, (event) => {
        const data = JSON.parse(event);
        if (data.type === "abort-stream") {
          console.log("cancelling http stream");
          resumableStream?.cancel();
        }
      });

      return new Response(resumableStream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-vercel-ai-ui-message-stream": "v1",
          "x-accel-buffering": "no",
        },
        status: 200,
      });
    },
  };
}

/**
 * Set up an abort callback for a stream
 */
export async function setupAbortCallback(
  appId: string,
  callback: () => void
): Promise<void> {
  redis.subscribe(`events:${appId}`, (event) => {
    const data = JSON.parse(event);
    if (data.type === "abort-stream") {
      callback();
    }
  });
}

/**
 * Update the keep-alive timestamp for a stream
 */
export async function updateKeepAlive(appId: string): Promise<void> {
  await redisPublisher.set(`app:${appId}:stream-state`, "running", {
    EX: 15,
  });
}

/**
 * Handle stream lifecycle events (start, finish, error)
 */
export async function handleStreamLifecycle(
  appId: string,
  event: "start" | "finish" | "error"
): Promise<void> {
  switch (event) {
    case "start":
      await updateKeepAlive(appId);
      break;
    case "finish":
    case "error":
      await clearStreamState(appId);
      break;
  }
}

/**
 * Send a message to the AI and handle all stream plumbing internally
 * Main entry point used by the API routes
 */
export async function sendMessageWithStreaming(
  agent: Agent,
  appId: string,
  mcpUrl: string,
  fs: FreestyleDevServerFilesystem,
  message: UIMessage
) {
  const controller = new AbortController();
  let shouldAbort = false;

  // Set up abort callback
  await setupAbortCallback(appId, () => {
    shouldAbort = true;
  });

  let lastKeepAlive = Date.now();

  // נחשב אומדן לקלט כדי לא לחצות ITPM
  const estimatedInput = estimateTokens(
    typeof message?.content === "string"
      ? message.content
      : JSON.stringify(message ?? {})
  );

  // נמתין לתקציב לדקה במידת הצורך
  await waitForBudget(estimatedInput);

  // הפעלה עם תור + ריטריי + הקטנת פלט
  const aiResponse = await limiter.schedule(() =>
    withRetry(() =>
      AIService.sendMessage(agent, appId, mcpUrl, fs, message, {
        threadId: appId,
        resourceId: appId,
        maxSteps: 100,
        maxRetries: 0,
        // תקרת פלט (OTPM) נשלטת ע"י ENV; ברירת מחדל 800
        maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS || 800),
        async onChunk() {
          if (Date.now() - lastKeepAlive > 5000) {
            lastKeepAlive = Date.now();
            await updateKeepAlive(appId);
          }
        },
        async onStepFinish(_step: { response: { messages: unknown[] } }) {
          if (shouldAbort) {
            await handleStreamLifecycle(appId, "error");
            controller.abort("Aborted stream after step finish");
            const messages = await AIService.getUnsavedMessages(appId);
            console.log(messages);
            await AIService.saveMessagesToMemory(agent, appId, messages);
          }
        },
        onError: async (error: { error: unknown }) => {
          console.error("Stream error in manager:", error);
          await handleStreamLifecycle(appId, "error");
        },
        onFinish: async () => {
          await handleStreamLifecycle(appId, "finish");
        },
        abortSignal: controller.signal,
      })
    )
  );

  if (!aiResponse.stream?.toUIMessageStreamResponse) {
    console.error("Stream missing toUIMessageStreamResponse method!");
    throw new Error(
      "Invalid stream format - missing toUIMessageStreamResponse method"
    );
  }

  return await setStream(appId, message, aiResponse.stream);
}
