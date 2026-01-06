import { z } from "zod";

export const BaseOAuthState = z.object({
  callbackUrl: z.string().optional(),
});

export const SlackBotOAuthState = BaseOAuthState.extend({
  instanceId: z.string().optional(),
  link: z
    .object({
      userId: z.string(),
      email: z.string().email(),
    })
    .optional(),
});

export const GoogleOAuthState = BaseOAuthState.extend({
  link: z.object({
    userId: z.string(),
  }),
});

export type BaseOAuthState = z.infer<typeof BaseOAuthState>;
export type SlackBotOAuthState = z.infer<typeof SlackBotOAuthState>;
export type GoogleOAuthState = z.infer<typeof GoogleOAuthState>;
