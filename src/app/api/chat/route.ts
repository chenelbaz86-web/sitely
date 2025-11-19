// מעל POST
const DEV_SERVER_TIMEOUT_MS = 15_000;

export async function POST(req: NextRequest) {
  console.log("creating new chat stream");
  const appId = getAppIdFromHeaders(req);
  if (!appId) return new Response("Missing App Id header", { status: 400 });

  const app = await getApp(appId);
  if (!app) return new Response("App not found", { status: 404 });

  // ... הקטע של isStreamRunning נשאר כמו שהוא ...

  const { messages }: { messages: UIMessage[] } = await req.json();

  // ✅ לוגים שיעזרו להבין למה dev server לא מגיע
  console.log("[DEV]", "repoId =", app.info.gitRepo);
  console.log("[DEV]", "FREESTYLE_API_KEY set =", !!process.env.FREESTYLE_API_KEY);

  let mcpEphemeralUrl: string | undefined;
  let fs: any | undefined;
  try {
    console.log("requesting dev server…");
    const { mcpEphemeralUrl: url, fs: filesystem } = await Promise.race([
      freestyle.requestDevServer({ repoId: app.info.gitRepo }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Dev server timeout")), DEV_SERVER_TIMEOUT_MS)),
    ]) as any;

    mcpEphemeralUrl = url;
    fs = filesystem;
    console.log("dev server ready");
  } catch (e: any) {
    console.error("dev server unavailable:", e?.message || e);
    return new Response("Dev server unavailable, please try again later.", { status: 503 });
  }

  const resumableStream = await sendMessageWithStreaming(
    builderAgent,
    appId,
    mcpEphemeralUrl!,
    fs!,
    messages.at(-1)!
  );

  return resumableStream.response();
}
