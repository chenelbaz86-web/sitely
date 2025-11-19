import { getStream, stopStream } from "@/lib/internal/stream-manager";
import { NextRequest } from "next/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  console.log("GET stream for appId:", (await params).id);
  const currentStream = await getStream((await params).id);

  if (!currentStream) {
    return new Response();
  }

  return currentStream?.response();
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const appId = (await params).id;

  await stopStream(appId);

  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "text/plain",
    },
  });
}
