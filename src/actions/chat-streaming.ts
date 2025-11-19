"use server";

import { getStreamState } from "@/lib/internal/stream-manager";

export async function chatState(appId: string) {
  const streamState = await getStreamState(appId);
  return streamState;
}
