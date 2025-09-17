import { generateState, parseState, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/plugins";
import { sessionMiddleware } from "better-auth/api";
import { createAuthorizationURL, validateAuthorizationCode } from "better-auth/oauth2";
import { z } from "zod";
import { getContext } from "hono/context-storage";
import { eq } from "drizzle-orm";
import type { Variables } from "../worker";
import * as schema from "../db/schema.ts";
import { type CloudflareEnv } from "../../env.ts";

export const SLACK_BOT_SCOPES = [
  "channels:history",
  "channels:join",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "commands",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "im:write.topic",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "mpim:write.topic",
  "reactions:read",
  "reactions:write",
  "users.profile:read",
  "users:read",
  "users:read.email",
  "assistant:write",
];

export const integrationsPlugin = () =>
  ({
    id: "integrations",
    endpoints: {
      linkSlackBot: createAuthEndpoint(
        "/integrations/link/slack-bot",
        {
          method: "POST",
          body: z.object({
            estateId: z.string(),
            callbackURL: z.string(),
          }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const { estateId } = ctx.body;
          const session = ctx.context.session;

          const {
            env,
            var: { db },
          } = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();

          const member = await db.query.estate.findFirst({
            where: eq(schema.estate.id, estateId),
            columns: {},
            with: {
              organization: {
                columns: {},
                with: {
                  members: {
                    columns: {
                      userId: true,
                    },
                    where: eq(schema.organizationUserMembership.userId, session.user.id),
                  },
                },
              },
            },
          });

          if (!member) {
            throw new Error("You are not a member of this estate");
          }

          const { state } = await generateState(ctx, {
            email: `${session.user.email}|${estateId}`,
            userId: session.user.id,
          });

          const redirectURI = `${env.VITE_PUBLIC_URL}/api/auth/integrations/callback/slack-bot`;
          const url = await createAuthorizationURL({
            id: "slack-bot",
            options: {
              clientId: env.SLACK_CLIENT_ID,
              clientSecret: env.SLACK_CLIENT_SECRET,
              redirectURI,
            },
            redirectURI,
            authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
            scopes: SLACK_BOT_SCOPES,
            state,
          });

          return ctx.json({ url });
        },
      ),
      callbackSlack: createAuthEndpoint(
        "/integrations/callback/slack-bot",
        {
          method: "GET",
          query: z.object({
            code: z
              .string()
              .meta({
                description: "The OAuth2 code",
              })
              .optional(),
            error: z
              .string()
              .meta({
                description: "The error message, if any",
              })
              .optional(),
            error_description: z
              .string()
              .meta({
                description: "The error description, if any",
              })
              .optional(),
            state: z
              .string()
              .meta({
                description: "The state parameter from the OAuth2 request",
              })
              .optional(),
          }),
        },
        async (ctx) => {
          const parsedState = await parseState(ctx);
          const { link, callbackURL } = parsedState;
          const code = ctx.query.code;
          if (!code) {
            return ctx.json({ error: "No code provided" });
          }
          if (!link) {
            return ctx.json({ error: "No associated user found with the oauth session" });
          }
          const {
            env,
            var: { db },
          } = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();

          const redirectURI = `${env.VITE_PUBLIC_URL}/api/auth/integrations/callback/slack-bot`;

          const tokens = await validateAuthorizationCode({
            code,
            options: {
              clientId: env.SLACK_CLIENT_ID,
              clientSecret: env.SLACK_CLIENT_SECRET,
              redirectURI,
            },
            tokenEndpoint: "https://slack.com/api/oauth.v2.access",
            redirectURI,
          }).catch(() => {
            console.error("Invalid code");
            return null;
          });

          if (!tokens || !tokens.accessToken) {
            return ctx.json({ error: "Failed to get tokens" });
          }

          const body = new FormData();
          body.append("token", tokens.accessToken);
          const botAuth = await fetch(`https://slack.com/api/auth.test`, {
            headers: {
              Authorization: `Bearer ${tokens.accessToken}`,
              Accept: "application/json",
            },
            method: "POST",
            body,
          });

          if (!botAuth.ok) {
            return ctx.json({ error: "Failed to authenticate bot" });
          }

          const botAuthData = (await botAuth.json()) as { user_id: string };
          const botUserId = botAuthData.user_id;

          const existingAccount = await ctx.context.internalAdapter.findAccount(botUserId);

          let accountId = existingAccount?.id;
          if (existingAccount) {
            await ctx.context.internalAdapter.updateAccount(existingAccount.id, {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              scope: SLACK_BOT_SCOPES.join(" "),
              accessTokenExpiresAt: tokens.accessTokenExpiresAt,
              accountId: botUserId,
            });
          } else {
            const newAccount = await ctx.context.internalAdapter.createAccount({
              providerId: "slack-bot",
              userId: link?.userId,
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              scope: SLACK_BOT_SCOPES.join(" "),
              accessTokenExpiresAt: tokens.accessTokenExpiresAt,
              accountId: botUserId,
            });
            accountId = newAccount.id;
          }
          if (!accountId) {
            return ctx.json({ error: "Failed to get account id" });
          }
          const estateId = link?.email.split("|")[1];
          if (!estateId) {
            return ctx.json({ error: "Failed to get estate id" });
          }

          await db
            .insert(schema.estateAccountsPermissions)
            .values({
              accountId,
              estateId,
            })
            .onConflictDoNothing();

          return ctx.redirect(callbackURL);
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
