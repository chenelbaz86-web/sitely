"use server";

import { getUser } from "@/auth/stack-auth";
import { appsTable, appUsers } from "@/db/schema";
import { db } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { freestyle } from "@/lib/freestyle";

export async function deleteApp(appId: string) {
  const user = await getUser();

  // Check if user has permission to delete this app
  const userApp = await db
    .select()
    .from(appUsers)
    .where(and(eq(appUsers.appId, appId), eq(appUsers.userId, user.userId)))
    .limit(1)
    .then((apps) => apps.at(0));

  if (!userApp || userApp.permissions !== "admin") {
    throw new Error("Unauthorized to delete this app");
  }

  // Get app info before deletion
  const app = await db
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1)
    .then((apps) => apps.at(0));

  if (!app) {
    throw new Error("App not found");
  }

  await db.delete(appsTable).where(eq(appsTable.id, appId));

  try {
    if (app.gitRepo) {
      await freestyle.deleteGitRepository({
        repoId: app.gitRepo,
      });
    }
  } catch (error) {
    console.warn("Failed to delete remote repository:", error);
    // We still consider the deletion successful even if remote cleanup fails
  }

  return { success: true };
}
