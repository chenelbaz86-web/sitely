"use server";

import { appsTable, messagesTable } from "@/db/schema";
import { db } from "@/db/schema";
import { asc, eq } from "drizzle-orm";

export async function getApp(id: string) {
  const app = await db
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, id))
    .limit(1);

  if (!app) {
    throw new Error("App not found");
  }

  const appInfo = app[0];

  if (!appInfo) {
    throw new Error("App not found");
  }

  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.appId, appInfo.id))
    .orderBy(asc(messagesTable.createdAt));

  return {
    info: appInfo,
    messages: messages.map((msg) => {
      return msg.message;
    }),
  };
}
