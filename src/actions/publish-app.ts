"use server";

import { getUser } from "@/auth/stack-auth";
import { appDeployments, appsTable, appUsers } from "@/db/schema";
import { db } from "@/db/schema";
import { freestyle } from "@/lib/freestyle";
import { eq, sql } from "drizzle-orm";
import {
  adjectives,
  animals,
  uniqueNamesGenerator,
} from "unique-names-generator";

export async function publishApp({ appId }: { appId: string }) {
  const user = await getUser();

  if (!user) {
    throw new Error("User not found");
  }

  const app = await db
    .select({
      app: appsTable,
      users: sql<
        Array<{
          userId: string;
        }>
      >`json_agg(${appUsers})`.as("users"),
    })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .leftJoin(appUsers, eq(appUsers.appId, appsTable.id))
    .groupBy(appsTable.id)
    .limit(1)
    .then((res) => res.at(0));

  if (!app) {
    throw new Error("App not found");
  }

  if (!app.users) {
    throw new Error("No users found for this app");
  }

  if (!app.users.some((user) => user.userId === user.userId)) {
    throw new Error("User does not have permission to publish this app");
  }

  if (!process.env.PREVIEW_DOMAIN) {
    throw new Error("Preview domain is not configured");
  }

  let previewDomain = app.app.previewDomain;
  if (app.app.previewDomain === null) {
    const domainPrefix = uniqueNamesGenerator({
      dictionaries: [adjectives, animals],
      separator: "",
      length: 2,
    });
    const domain = `${domainPrefix}.${process.env.PREVIEW_DOMAIN}`;

    console.log("Generated domain:", domain);

    await db
      .update(appsTable)
      .set({ previewDomain: domain })
      .where(eq(appsTable.id, appId))
      .execute();

    previewDomain = domain;
  }

  if (!previewDomain) {
    throw new Error("Preview domain is not set. This should not happen.");
  }

  const deployment = await freestyle.deployWeb(
    {
      kind: "git",
      url: `https://git.freestyle.sh/${app.app.gitRepo}`,
    },
    {
      build: true,
      domains: [previewDomain],
    }
  );

  if (deployment.message) {
    console.error("Deployment failed:", deployment.message);
    throw new Error(`Deployment failed`);
  }

  db.insert(appDeployments).values({
    appId: app.app.id,
    deploymentId: deployment.deploymentId,
    createdAt: new Date(),
    commit: "latest",
  });

  return true;
}
