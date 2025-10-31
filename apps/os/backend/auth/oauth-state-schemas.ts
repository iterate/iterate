import { z } from "zod";

export const DynamicClientInfo = z.looseObject({
  client_id: z.string(),
  client_secret: z.string().optional(),
  token_endpoint: z.string().optional(),
});

export type DynamicClientInfo = z.infer<typeof DynamicClientInfo>;

export const AgentDurableObjectInfo = z.object({
  durableObjectId: z.string(),
  durableObjectName: z.string(),
  className: z.string(),
});

export type AgentDurableObjectInfo = z.infer<typeof AgentDurableObjectInfo>;

export const BaseOAuthState = z.object({
  callbackUrl: z.string().optional(),
  fullUrl: z.string().optional(),
  agentDurableObject: AgentDurableObjectInfo.optional(),
});

export const MCPOAuthState = BaseOAuthState.extend({
  integrationSlug: z.string(),
  serverUrl: z.url(),
  estateId: z.string(),
  userId: z.string(),
  clientId: z.string(),
  serverId: z.string(),
});

export const SlackDirectLoginState = BaseOAuthState.extend({});

export const SlackBotLinkState = BaseOAuthState.extend({
  estateId: z.string(),
  link: z.object({
    userId: z.string(),
    email: z.string().email(),
  }),
});

export const SlackBotOAuthState = BaseOAuthState.extend({
  estateId: z.string().optional(),
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
export type MCPOAuthState = z.infer<typeof MCPOAuthState>;
export type SlackDirectLoginState = z.infer<typeof SlackDirectLoginState>;
export type SlackBotLinkState = z.infer<typeof SlackBotLinkState>;
export type SlackBotOAuthState = z.infer<typeof SlackBotOAuthState>;
export type GoogleOAuthState = z.infer<typeof GoogleOAuthState>;
