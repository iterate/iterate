import { z } from "zod";
import { t } from "../config.ts";
import { getRepoAccessToken } from "../github-utils.ts";

export const ghPrintSetup = t.procedure
  .input(
    z.object({
      estateId: z.string(),
    }),
  )
  .mutation(async ({ input }) => {
    const { estateId } = input;
    const { token } = await getRepoAccessToken(estateId);
    console.log(`Use this token to authenticate with the token scoped to this estate`);
    console.log(`export GH_TOKEN=${token}`);
  });

export const gh = t.router({
  printSetup: ghPrintSetup,
});
