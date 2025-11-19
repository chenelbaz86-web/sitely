import "server-only";

import { StackServerApp } from "@stackframe/stack";
import { freestyle } from "@/lib/freestyle";

export const stackServerApp = new StackServerApp({
  tokenStore: "nextjs-cookie",
});

export async function getUser() {
  const user = await stackServerApp.getUser();

  if (!user) {
    throw new Error("User not found");
  }

  if (!user?.serverMetadata?.freestyleIdentity) {
    const gitIdentity = await freestyle.createGitIdentity();

    await user.update({
      serverMetadata: {
        freestyleIdentity: gitIdentity.id,
      },
    });

    user.serverMetadata.freestyleIdentity = gitIdentity.id;
  }

  return {
    userId: user.id,
    freestyleIdentity: user.serverMetadata.freestyleIdentity,
  };
}
