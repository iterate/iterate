import { type BetterAuthPlugin, type User } from "better-auth";
import { createAuthEndpoint } from "better-auth/plugins";
import { sessionMiddleware } from "better-auth/api";
import { createAuthorizationURL } from "better-auth/oauth2";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { generateRandomString } from "better-auth/crypto";
import { getContext } from "hono/context-storage";
import { eq, and } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import { waitUntil } from "cloudflare:workers";
import { logger } from "../tag-logger.ts";
import type { Variables } from "../worker";
import * as schema from "../db/schema.ts";
import { env, type CloudflareEnv } from "../../env.ts";
import { IterateAgent } from "../agent/iterate-agent.ts";
import { SlackAgent } from "../agent/slack-agent.ts";
import { syncSlackUsersInBackground } from "../integrations/slack/slack.ts";
import { MCPOAuthState, SlackBotOAuthState } from "./oauth-state-schemas.ts";

export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:join",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users.profile:read",
  "users:read",
  "users:read.email",
  "assistant:write",
];

export const SLACK_USER_AUTH_SCOPES = [
  "identity.email",
  "identity.basic",
  "identity.team",
  "identity.avatar",
];

export const integrationsPlugin = () =>
  ({
    id: "integrations",
    endpoints: {
      // MCP OAuth callback endpoint
      callbackMCP: createAuthEndpoint(
        "/integrations/callback/mcp",
        {
          method: "GET",
          query: z.object({
            code: z.string(),
            state: z.string().optional(),
            error: z.string().optional(),
            error_description: z.string().optional(),
          }),
        },
        async (ctx) => {
          const { code, state: stateId, error, error_description } = ctx.query;

          if (error) {
            return ctx.json(
              {
                error: "OAuth authorization failed",
                details: { error, error_description },
              },
              { status: 400 },
            );
          }

          if (!stateId) {
            return ctx.json(
              {
                error: "Missing state parameter",
                details:
                  "The MCP OAuth provider did not return the state parameter. This violates OAuth 2.0 security standards.",
                code,
                helpUrl: "https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.2",
              },
              { status: 400 },
            );
          }

          const rawState = await ctx.context.internalAdapter.findVerificationValue(stateId);
          if (!rawState) {
            return ctx.json({ error: "Invalid or expired state" }, { status: 400 });
          }

          const parsedStateResult = MCPOAuthState.safeParse(JSON.parse(rawState.value));
          if (!parsedStateResult.success) {
            return ctx.json({ error: "Invalid state data format" }, { status: 400 });
          }

          const state = parsedStateResult.data;

          const {
            var: { db },
          } = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();

          const result = await db
            .select({
              estate: schema.estate,
            })
            .from(schema.estate)
            .innerJoin(
              schema.organizationUserMembership,
              and(
                eq(schema.organizationUserMembership.organizationId, schema.estate.organizationId),
                eq(schema.organizationUserMembership.userId, state.userId),
              ),
            )
            .where(eq(schema.estate.id, state.estateId))
            .limit(1);

          const estateWithMembership = result[0]?.estate;

          if (!estateWithMembership) {
            logger.error("Estate not found or user not authorized", {
              estateId: state.estateId,
              userId: state.userId,
            });
            return ctx.json({ error: "Estate not found" }, { status: 404 });
          }

          await ctx.context.internalAdapter.deleteVerificationValue(stateId);

          if (state.agentDurableObject) {
            const params = {
              db,
              agentInstanceName: state.agentDurableObject.durableObjectName,
            };
            const agentStub =
              state.agentDurableObject.className === "SlackAgent"
                ? await SlackAgent.getStubByName(params)
                : await IterateAgent.getStubByName(params);

            await agentStub.addEvents([
              {
                type: "MCP:CONNECT_REQUEST",
                data: {
                  serverUrl: state.serverUrl,
                  mode: state.userId ? "personal" : "company",
                  userId: state.userId,
                  integrationSlug: state.integrationSlug,
                  reconnect: {
                    oauthClientId: state.clientId,
                    oauthCode: code,
                  },
                },
              },
            ]);
          }

          if (!state.callbackUrl) {
            return ctx.redirect(import.meta.env.VITE_PUBLIC_URL);
          }

          return ctx.redirect(state.callbackUrl.toString());
        },
      ),

      directLoginWithSlack: createAuthEndpoint(
        "/integrations/direct-login-with-slack",
        {
          method: "GET",
          query: z.object({
            callbackURL: z.string().default("/"),
            mode: z.enum(["redirect", "json"]).default("json"),
          }),
        },
        async (ctx) => {
          const state = generateRandomString(32);
          const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

          const data = JSON.stringify({
            callbackURL: ctx.query.callbackURL,
          });

          await ctx.context.internalAdapter.createVerificationValue({
            expiresAt,
            identifier: state,
            value: data,
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
            additionalParams: {
              user_scope: SLACK_USER_AUTH_SCOPES.join(","),
            },
          });

          // If mode is redirect, redirect directly to OAuth URL
          if (ctx.query.mode === "redirect") {
            return ctx.redirect(url.toString());
          }

          return ctx.json({ url });
        },
      ),
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
          const { estateId, callbackURL } = ctx.body;
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

          const state = generateRandomString(32);
          const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

          const data = JSON.stringify({
            estateId,
            link: {
              userId: session.user.id,
              email: session.user.email,
            },
            callbackURL,
          });

          await ctx.context.internalAdapter.createVerificationValue({
            expiresAt,
            identifier: state,
            value: data,
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
            additionalParams: {
              user_scope: SLACK_USER_AUTH_SCOPES.join(","),
            },
          });

          return ctx.json({ url });
        },
      ),
      callbackSlackSearch: createAuthEndpoint(
        "/integrations/callback/slack-search",
        {
          method: "GET",
          query: z.object({
            error: z.string().optional(),
            error_description: z.string().optional(),
            code: z.string(),
            state: z.string(),
          }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const { code, state: stateId, error, error_description } = ctx.query;
          const session = ctx.context.session;

          if (error) {
            return ctx.json(
              {
                error: "OAuth authorization failed",
                details: { error, error_description },
              },
              { status: 400 },
            );
          }

          const {
            env,
            var: { db },
          } = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();

          const value = await ctx.context.internalAdapter.findVerificationValue(stateId);
          if (!value) {
            return ctx.json({ error: "Invalid state" }, { status: 400 });
          }

          const stateData = JSON.parse(value.value);
          const callbackURL = stateData.callbackURL || import.meta.env.VITE_PUBLIC_URL;
          const agentDurableObject = stateData.agentDurableObject;

          const estateId = stateData.estateId;

          await ctx.context.internalAdapter.deleteVerificationValue(stateId);

          const redirectURI = `${env.VITE_PUBLIC_URL}/api/auth/integrations/callback/slack-search`;
          const unauthedSlackClient = new WebClient();

          const tokens = await unauthedSlackClient.oauth.v2.access({
            client_id: env.SLACK_CLIENT_ID,
            client_secret: env.SLACK_CLIENT_SECRET,
            code: code,
            redirect_uri: redirectURI,
          });

          if (!tokens || !tokens.ok || !tokens.authed_user || !tokens.authed_user.access_token) {
            return ctx.json({ error: "Failed to get tokens", details: tokens.error });
          }

          const userSlackClient = new WebClient(tokens.authed_user.access_token);
          const userInfo = await userSlackClient.users.identity({});

          if (
            !userInfo ||
            !userInfo.ok ||
            !userInfo.user ||
            !userInfo.user.email ||
            !userInfo.user.id
          ) {
            return ctx.json({ error: "Failed to get user info", details: userInfo.error });
          }

          if (userInfo.user.email !== session.user.email) {
            return ctx.json({ error: "User mismatch" }, { status: 403 });
          }

          const existingSearchAccount = await db.query.account.findFirst({
            where: and(
              eq(schema.account.providerId, "slack-search"),
              eq(schema.account.userId, session.user.id),
            ),
          });

          let accountId: string;
          if (existingSearchAccount) {
            await ctx.context.internalAdapter.updateAccount(existingSearchAccount.id, {
              accessToken: tokens.authed_user.access_token,
              scope: "search:read",
              accountId: userInfo.user.id,
            });
            accountId = existingSearchAccount.id;
          } else {
            const newAccount = await ctx.context.internalAdapter.createAccount({
              providerId: "slack-search",
              accountId: userInfo.user.id,
              userId: session.user.id,
              accessToken: tokens.authed_user.access_token,
              scope: "search:read",
            });
            accountId = newAccount.id;
          }

          if (estateId) {
            const existingPermission = await db.query.estateAccountsPermissions.findFirst({
              where: and(
                eq(schema.estateAccountsPermissions.accountId, accountId),
                eq(schema.estateAccountsPermissions.estateId, estateId),
              ),
            });

            if (!existingPermission) {
              await db.insert(schema.estateAccountsPermissions).values({
                accountId,
                estateId,
              });
            }
          }

          if (agentDurableObject) {
            const params = {
              db,
              agentInstanceName: agentDurableObject.durableObjectName,
            };
            const agentStub = await SlackAgent.getStubByName(params);

            await agentStub.addEvents([
              {
                type: "CORE:LLM_INPUT_ITEM",
                data: {
                  type: "message",
                  role: "developer",
                  content: [
                    {
                      type: "input_text",
                      text: "The user has granted Slack search permissions. Please retry the search query now.",
                    },
                  ],
                },
                triggerLLMRequest: true,
              },
            ]);
          }

          return ctx.redirect(callbackURL);
        },
      ),
      callbackSlack: createAuthEndpoint(
        "/integrations/callback/slack-bot",
        {
          method: "GET",
          query: z.object({
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
            code: z.string().meta({
              description: "The OAuth2 code",
            }),
            state: z.string().meta({
              description: "The state parameter from the OAuth2 request",
            }),
          }),
        },
        async (ctx) => {
          const value = await ctx.context.internalAdapter.findVerificationValue(ctx.query.state);
          if (!value) {
            return ctx.json({ error: "Invalid state" });
          }

          const parsedState = SlackBotOAuthState.parse(JSON.parse(value.value));

          const { link, callbackUrl: callbackURL } = parsedState;
          const estateId = parsedState.estateId;

          const code = ctx.query.code;

          const {
            env,
            var: { db },
          } = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();

          const redirectURI = `${env.VITE_PUBLIC_URL}/api/auth/integrations/callback/slack-bot`;

          const unauthedSlackClient = new WebClient();

          const tokens = await unauthedSlackClient.oauth.v2.access({
            client_id: env.SLACK_CLIENT_ID,
            client_secret: env.SLACK_CLIENT_SECRET,
            code: code,
            redirect_uri: redirectURI,
          });

          if (
            !tokens.ok ||
            !tokens.authed_user ||
            !tokens.authed_user.access_token ||
            !tokens.bot_user_id ||
            !tokens.team?.id
          ) {
            return ctx.json({ error: "Failed to get tokens", details: tokens.error });
          }

          if (!tokens || !tokens.access_token || !tokens.authed_user.access_token) {
            return ctx.json({ error: "Failed to get tokens" });
          }

          const userSlackClient = new WebClient(tokens.authed_user.access_token);

          const userInfo = await userSlackClient.users.identity({});

          if (
            !userInfo ||
            !userInfo.ok ||
            !userInfo.user ||
            !userInfo.user.email ||
            !userInfo.user.id
          ) {
            return ctx.json({ error: "Failed to get user info", details: userInfo.error });
          }

          const botUserId = tokens.bot_user_id;

          let user: User | null = null;

          if (!link) {
            const existingUser = await ctx.context.internalAdapter.findUserByEmail(
              userInfo.user.email,
            );
            if (existingUser) {
              await ctx.context.internalAdapter.updateUser(existingUser.user.id, {
                name: userInfo.user.name,
                image: userInfo.user.image_192,
              });
              user = existingUser.user;
            } else {
              user = await ctx.context.internalAdapter.createUser({
                email: userInfo.user.email,
                name: userInfo.user.name || "",
                image: userInfo.user.image_192,
                emailVerified: true,
              });

              if (env.ADMIN_EMAIL_HOSTS) {
                const emailDomain = userInfo.user.email.split("@")[1];
                const adminHosts = env.ADMIN_EMAIL_HOSTS.split(",").map((host) => host.trim());

                if (emailDomain && adminHosts.includes(emailDomain)) {
                  await ctx.context.internalAdapter.updateUser(user.id, {
                    role: "admin",
                  });
                }
              }
            }

            const existingUserAccount = existingUser?.accounts.find(
              (account) => account.providerId === "slack",
            );
            if (existingUserAccount) {
              await ctx.context.internalAdapter.updateAccount(existingUserAccount.id, {
                accessToken: tokens.authed_user.access_token,
                scope: SLACK_USER_AUTH_SCOPES.join(","),
                accountId: tokens.authed_user.id,
              });
            } else {
              await ctx.context.internalAdapter.createAccount({
                providerId: "slack",
                accountId: userInfo.user.id,
                userId: user.id,
                accessToken: tokens.authed_user.access_token,
                scope: SLACK_USER_AUTH_SCOPES.join(","),
              });
            }

            const session = await ctx.context.internalAdapter.createSession(user.id, ctx);
            await setSessionCookie(ctx, {
              session,
              user,
            });
          } else {
            const linkedUser = await ctx.context.internalAdapter.findUserByEmail(link.email);
            if (!linkedUser) {
              return ctx.json({ error: "Can't find the existing user to link to" });
            }
            user = linkedUser.user;
          }

          if (!user) {
            return ctx.json({ error: "Failed to get user" });
          }

          let botAccount = await ctx.context.internalAdapter.findAccount(botUserId);
          if (botAccount) {
            await ctx.context.internalAdapter.updateAccount(botAccount.id, {
              accessToken: tokens.access_token,
              scope: SLACK_BOT_SCOPES.join(","),
              accountId: botUserId,
            });
          } else {
            botAccount = await ctx.context.internalAdapter.createAccount({
              providerId: "slack-bot",
              userId: user.id,
              accessToken: tokens.access_token,
              scope: SLACK_BOT_SCOPES.join(","),
              accountId: botUserId,
            });
          }

          if (!botAccount) {
            return ctx.json({ error: "Failed to get account id" });
          }

          // For direct signup, just redirect and let the org-layout handle everything
          if (!link) {
            return ctx.redirect(callbackURL || import.meta.env.VITE_PUBLIC_URL);
          }

          // For linking flow, we need an estateId
          if (!estateId) {
            return ctx.json({ error: "Failed to get estate id for linking" });
          }

          // For linking flow, connect everything now
          // Sync Slack users to the organization in the background
          waitUntil(syncSlackUsersInBackground(db, tokens.access_token, estateId));

          await db
            .insert(schema.estateAccountsPermissions)
            .values({
              accountId: botAccount.id,
              estateId,
            })
            .onConflictDoNothing();

          await db
            .insert(schema.providerEstateMapping)
            .values({
              internalEstateId: estateId,
              externalId: tokens.team?.id,
              providerId: "slack-bot",
              providerMetadata: {
                botUserId,
                team: tokens.team,
              },
            })
            .onConflictDoUpdate({
              target: [
                schema.providerEstateMapping.providerId,
                schema.providerEstateMapping.externalId,
              ],
              set: {
                internalEstateId: estateId, // We may want to require a confirmation to change the estate
                providerMetadata: {
                  botUserId,
                  team: tokens.team,
                },
              },
            });

          return ctx.redirect(callbackURL || import.meta.env.VITE_PUBLIC_URL);
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
