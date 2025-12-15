import { z } from "zod";
import { t } from "../config.ts";

export const ghPrintSetup = t.procedure
  .input(
    z.object({
      installationId: z.string(),
    }),
  )
  .mutation(async ({ input }) => {
    const { installationId } = input;
    const { getRepoAccessToken } = await import("../github-utils.ts");
    const { token } = await getRepoAccessToken(installationId);
    console.log(`Use this token to authenticate with the token scoped to this installation`);
    console.log(`export GH_TOKEN=${token}`);
  });

export const gh = t.router({
  printSetup: ghPrintSetup,
});
