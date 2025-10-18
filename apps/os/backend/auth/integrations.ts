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
import { waitUntil } from "../../env.ts";
import { logger } from "../tag-logger.ts";
import type { Variables } from "../worker";
import * as schema from "../db/schema.ts";
import { env, type CloudflareEnv } from "../../env.ts";
import { syncSlackForEstateInBackground } from "../integrations/slack/slack.ts";
import { createUserOrganizationAndEstate } from "../org-utils.ts";
import { createStripeCustomerAndSubscriptionForOrganization } from "../integrations/stripe/stripe.ts";
import { getAgentStubByName, toAgentClassName } from "../agent/agents/stub-getters.ts";
import { MCPOAuthState, SlackBotOAuthState, GoogleOAuthState } from "./oauth-state-schemas.ts";

export const SLACK_BOT_SCOPES = [
  "channels:history",
  "channels:join",
  "channels:manage", // Required for conversations.create
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
  "conversations.connect:write", // Required for Slack Connect invitations
];

export const SLACK_USER_AUTH_SCOPES = ["openid", "profile", "email"];

export const GOOGLE_INTEGRATION_SCOPES = [
  // approved scopes
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "openid",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  // unapproved scopes
  "https://www.googleapis.com/auth/gmail.modify",
];

export const integrationsPlugin = () =>
  ({
    id: "integrations",
    endpoints: {
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
            const agentStub = await getAgentStubByName(
              toAgentClassName(state.agentDurableObject.className),
              params,
            );

            await agentStub.addEvents([
              {
                type: "MCP:CONNECT_REQUEST",
                data: {
                  serverUrl: state.serverUrl,
                  mode: state.userId ? "personal" : "company",
                  userId: state.userId,
                  integrationSlug: state.integrationSlug,
                  reconnect: {
                    id: state.serverId,
                    oauthClientId: state.clientId,
                    oauthCode: code,
                  },
                  triggerLLMRequestOnEstablishedConnection: false,
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
      linkGoogle: createAuthEndpoint(
        "/integrations/link/google",
        {
          method: "POST",
          body: z.object({
            callbackURL: z.string(),
          }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const { callbackURL } = ctx.body;
          const session = ctx.context.session;

          const { env } = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();

          const state = generateRandomString(32);
          const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

          const data = JSON.stringify({
            link: {
              userId: session.user.id,
            },
            callbackUrl: callbackURL,
          } satisfies GoogleOAuthState);

          await ctx.context.internalAdapter.createVerificationValue({
            expiresAt,
            identifier: state,
            value: data,
          });

          const redirectURI = `${env.VITE_PUBLIC_URL}/api/auth/integrations/callback/google`;
          const url = await createAuthorizationURL({
            id: "google",
            options: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              redirectURI,
            },
            redirectURI,
            authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
            scopes: GOOGLE_INTEGRATION_SCOPES,
            state,
            additionalParams: {
              access_type: "offline",
              prompt: "consent",
            },
          });

          return ctx.json({ url });
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
          let estateId = parsedState.estateId;

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

          if (
            !tokens ||
            !tokens.access_token ||
            !tokens.authed_user.access_token ||
            !tokens.authed_user.id
          ) {
            return ctx.json({ error: "Failed to get tokens" });
          }

          const userSlackClient = new WebClient(tokens.authed_user.access_token);

          const userInfo = await userSlackClient.openid.connect.userInfo({});

          if (!userInfo || !userInfo.ok || !userInfo.email || !userInfo.sub) {
            return ctx.json({ error: "Failed to get user info", details: userInfo.error });
          }

          const botUserId = tokens.bot_user_id;

          let user: User | null = null;

          if (!link) {
            const existingUser = await ctx.context.internalAdapter.findUserByEmail(userInfo.email);
            if (existingUser) {
              await ctx.context.internalAdapter.updateUser(existingUser.user.id, {
                name: userInfo.name,
                image: userInfo.picture,
              });
              user = existingUser.user;
            } else {
              user = await ctx.context.internalAdapter.createUser({
                email: userInfo.email,
                name: userInfo.name || "",
                image: userInfo.picture,
                emailVerified: true,
              });

              if (env.ADMIN_EMAIL_HOSTS) {
                const emailDomain = userInfo.email.split("@")[1];
                const adminHosts = env.ADMIN_EMAIL_HOSTS.split(",").map((host) => host.trim());

                if (emailDomain && adminHosts.includes(emailDomain)) {
                  await ctx.context.internalAdapter.updateUser(user.id, {
                    role: "admin",
                  });
                }
              }

              const newOrgAndEstate = await createUserOrganizationAndEstate(db, user);
              waitUntil(
                createStripeCustomerAndSubscriptionForOrganization(
                  db,
                  newOrgAndEstate.organization,
                  user,
                ).catch(() => {
                  // Error is already logged in the helper function
                }),
              );

              if (!newOrgAndEstate.estate) {
                return ctx.json({ error: "Failed to create an estate for the user" });
              }

              estateId = newOrgAndEstate.estate.id;
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
                accountId: tokens.authed_user.id,
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

          // Link estate if we have an ID
          // TODO(rahul): figure out if there are any edge cases
          // Only reason we don't have a estateId by this point is that the flow started with login, and the user already has an estate
          // So we can skip this step for them
          if (estateId) {
            // For linking flow, connect everything now
            // Sync Slack channels, users (internal and external) in the background
            if (!tokens.team?.id) {
              return ctx.json({ error: "Failed to get Slack team ID" });
            }

            waitUntil(
              syncSlackForEstateInBackground(db, tokens.access_token, estateId, tokens.team.id),
            );

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
                externalId: tokens.team.id,
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
          }

          return ctx.redirect(callbackURL || import.meta.env.VITE_PUBLIC_URL);
        },
      ),
      callbackGoogle: createAuthEndpoint(
        "/integrations/callback/google",
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

          const parsedState = GoogleOAuthState.parse(JSON.parse(value.value));
          const { link, callbackUrl: callbackURL, agentDurableObject } = parsedState;

          const {
            env,
            var: { db },
          } = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();

          const redirectURI = `${env.VITE_PUBLIC_URL}/api/auth/integrations/callback/google`;

          const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              code: ctx.query.code,
              client_id: env.GOOGLE_CLIENT_ID,
              client_secret: env.GOOGLE_CLIENT_SECRET,
              redirect_uri: redirectURI,
              grant_type: "authorization_code",
            }),
          });

          if (!tokenResponse.ok) {
            return ctx.json({ error: "Failed to exchange code for tokens" });
          }

          const tokens = (await tokenResponse.json()) as {
            access_token: string;
            refresh_token?: string;
            expires_in?: number;
          };

          if (!tokens.access_token) {
            return ctx.json({ error: "Failed to get access token" });
          }

          const accessTokenExpiresAt = tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000)
            : undefined;

          const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: {
              Authorization: `Bearer ${tokens.access_token}`,
            },
          });

          if (!userInfoResponse.ok) {
            return ctx.json({ error: "Failed to get user info" });
          }

          const userInfo = (await userInfoResponse.json()) as {
            email: string;
            id: string;
            name?: string;
            picture?: string;
          };

          if (!userInfo.id) {
            return ctx.json({ error: "Failed to get user info" });
          }

          const existingAccount = await ctx.context.internalAdapter.findAccount(userInfo.id);

          if (existingAccount) {
            await ctx.context.internalAdapter.updateAccount(existingAccount.id, {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              accessTokenExpiresAt,
              scope: GOOGLE_INTEGRATION_SCOPES.join(" "),
            });
          } else {
            const account = await ctx.context.internalAdapter.createAccount({
              providerId: "google",
              accountId: userInfo.id,
              userId: link.userId,
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              accessTokenExpiresAt,
              scope: GOOGLE_INTEGRATION_SCOPES.join(" "),
            });

            if (!account) {
              return ctx.json({ error: "Failed to create account" });
            }
          }

          if (agentDurableObject) {
            const params = {
              db,
              agentInstanceName: agentDurableObject.durableObjectName,
            };
            const agentStub = await getAgentStubByName(
              toAgentClassName(agentDurableObject.className),
              params,
            );
            await agentStub.addEvents([
              {
                type: "CORE:LLM_INPUT_ITEM",
                data: {
                  type: "message",
                  role: "developer",
                  content: [
                    {
                      type: "input_text",
                      text: `The user with ID ${link.userId} has completed authorizing with Google.`,
                    },
                  ],
                },
                triggerLLMRequest: true,
              },
            ]);
          }

          if (!callbackURL) {
            return ctx.redirect(import.meta.env.VITE_PUBLIC_URL);
          }

          return ctx.redirect(callbackURL);
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
