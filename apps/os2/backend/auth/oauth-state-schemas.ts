import { z } from "zod/v4";

export const SlackBotOAuthState = z.object({
  instanceId: z.string().optional(),
  link: z
    .object({
      userId: z.string(),
      email: z.string(),
    })
    .optional(),
  callbackUrl: z.string().optional(),
});

export type SlackBotOAuthState = z.infer<typeof SlackBotOAuthState>;

export const GoogleOAuthState = z.object({
  link: z.object({
    userId: z.string(),
  }),
  callbackUrl: z.string().optional(),
});

export type GoogleOAuthState = z.infer<typeof GoogleOAuthState>;
