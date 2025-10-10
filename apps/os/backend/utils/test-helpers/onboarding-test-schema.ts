import z from "zod/v4";

export const E2ETestParams = z.object({
  github: z.object({
    accessToken: z.string(),
    installationId: z.string(),
  }),
  slack: z.object({
    targetChannelId: z.string(),
    teamId: z.string(),
    user: z.object({
      id: z.string(),
      accessToken: z.string(),
    }),
    bot: z.object({
      id: z.string(),
      accessToken: z.string(),
    }),
  }),
});
