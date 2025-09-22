import { type BetterAuthPlugin, type User } from "better-auth";
import { createAuthEndpoint } from "better-auth/plugins";
import { sessionMiddleware } from "better-auth/api";
import { createAuthorizationURL } from "better-auth/oauth2";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { generateRandomString } from "better-auth/crypto";
import { getContext } from "hono/context-storage";
import { eq } from "drizzle-orm";
import type { Variables } from "../worker";
import * as schema from "../db/schema.ts";
import { env, type CloudflareEnv } from "../../env.ts";
import { IterateAgent } from "../agent/iterate-agent.ts";
import { SlackAgent } from "../agent/slack-agent.ts";

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

export const SLACK_USER_AUTH_SCOPES = [
  "identity.email",
  "identity.basic",
  "identity.team",
  "identity.avatar",
];

export const SlackBotOauthTokenResponse = z.object({
  access_token: z.string(),
  bot_user_id: z.string(),
  team: z.looseObject({
    id: z.string(),
    name: z.string(),
  }),
  authed_user: z.object({
    id: z.string(),
    access_token: z.string(),
  }),
});
export type SlackBotOauthTokenResponse = z.infer<typeof SlackBotOauthTokenResponse>;

export const UserInfoResponse = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image_192: z.string().optional(),
  }),
});
export type UserInfoResponse = z.infer<typeof UserInfoResponse>;

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
          const { code, state, error, error_description } = ctx.query;

          if (error) {
            return ctx.json(
              {
                error: "OAuth authorization failed",
                details: { error, error_description },
              },
              { status: 400 },
            );
          }

          let stateData: {
            integrationSlug: string;
            serverUrl: string;
            estateId: string;
            userId: string;
            callbackURL: string;
            clientId?: string;
            agentDurableObjectId?: string;
            agentDurableObjectName?: string;
            serverId?: string;
          };

          if (state) {
            const stateValue = await ctx.context.internalAdapter.findVerificationValue(state);
            if (!stateValue) {
              return ctx.json({ error: "Invalid or expired state" }, { status: 400 });
            }
            stateData = JSON.parse(stateValue.value);
          } else {
            console.warn(
              "MCP OAuth callback received without state parameter - this is a security risk",
            );

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

          const {
            var: { db },
          } = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();

          const estate = await db.query.estate.findFirst({
            where: eq(schema.estate.id, stateData.estateId),
            with: {
              organization: {
                with: {
                  members: true,
                },
              },
            },
          });

          if (!estate) {
            return ctx.json({ error: "Estate not found" }, { status: 404 });
          }

          const isMember = estate.organization.members.some(
            (member) => member.userId === stateData.userId,
          );

          if (!isMember) {
            console.error("Membership check failed:", {
              estateId: stateData.estateId,
              userId: stateData.userId,
              organizationId: estate.organization.id,
              members: estate.organization.members.map((m) => ({ userId: m.userId, role: m.role })),
            });
            return ctx.json(
              {
                error: "You are not a member of this estate",
                debug: {
                  estateId: stateData.estateId,
                  userId: stateData.userId,
                  organizationMembers: estate.organization.members.length,
                },
              },
              { status: 403 },
            );
          }

          await ctx.context.internalAdapter.deleteVerificationValue(state);

          if (stateData.agentDurableObjectId && stateData.agentDurableObjectName) {
            try {
              const isSlackAgent = stateData.agentDurableObjectName.startsWith("SlackAgent-");

              let agentStub: any;
              if (isSlackAgent) {
                agentStub = await SlackAgent.getStubByName({
                  db,
                  agentInstanceName: stateData.agentDurableObjectName,
                });
              } else {
                agentStub = await IterateAgent.getStubByName({
                  db,
                  agentInstanceName: stateData.agentDurableObjectName,
                });
              }

              await agentStub.addEvents([
                {
                  type: "MCP:CONNECT_REQUEST",
                  data: {
                    serverUrl: stateData.serverUrl,
                    mode: stateData.userId ? "personal" : "company",
                    userId: stateData.userId,
                    integrationSlug: stateData.integrationSlug,
                    requiresAuth: true,
                    reconnect: {
                      id: stateData.serverId || stateData.serverUrl,
                      oauthClientId: stateData.clientId,
                      oauthCode: code,
                    },
                  },
                },
              ]);
            } catch (error) {
              console.error("Failed to trigger agent reconnect:", error);
            }
          }

          const redirectUrl = new URL(stateData.callbackURL);
          redirectUrl.searchParams.set("mcp_oauth_complete", "true");
          redirectUrl.searchParams.set("server_url", stateData.serverUrl);
          redirectUrl.searchParams.set("integration_slug", stateData.integrationSlug);
          return ctx.redirect(redirectUrl.toString());
        },
      ),

      directLoginWithSlack: createAuthEndpoint(
        "/integrations/direct-login-with-slack",
        {
          method: "POST",
          body: z.object({
            callbackURL: z.string(),
          }),
        },
        async (ctx) => {
          const state = generateRandomString(32);
          const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

          const data = JSON.stringify({
            callbackURL: ctx.body.callbackURL,
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

          const parsedState = z
            .object({
              estateId: z.string().optional(),
              link: z
                .object({
                  userId: z.string(),
                  email: z.string(),
                })
                .optional(),
              callbackURL: z.string(),
            })
            .parse(JSON.parse(value.value));

          const { link, callbackURL } = parsedState;
          let estateId = parsedState.estateId;

          const code = ctx.query.code;

          const {
            env,
            var: { db },
          } = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();

          const redirectURI = `${env.VITE_PUBLIC_URL}/api/auth/integrations/callback/slack-bot`;

          const httpBasicAuth = btoa(`${env.SLACK_CLIENT_ID}:${env.SLACK_CLIENT_SECRET}`);
          const params = new URLSearchParams();
          params.set("code", code);
          params.set("redirect_uri", redirectURI);

          const tokenRes = await fetch(`https://slack.com/api/oauth.v2.access`, {
            method: "POST",
            body: params.toString(),
            headers: {
              Authorization: `Basic ${httpBasicAuth}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
          });

          if (!tokenRes.ok) {
            return ctx.json({ error: "Failed to get tokens" });
          }

          const tokens = SlackBotOauthTokenResponse.parse(await tokenRes.json());

          if (!tokens || !tokens.access_token || !tokens.authed_user.access_token) {
            return ctx.json({ error: "Failed to get tokens" });
          }

          const userInfo = await fetch(`https://slack.com/api/users.identity`, {
            headers: {
              Authorization: `Bearer ${tokens.authed_user.access_token}`,
            },
          });

          if (!userInfo.ok) {
            return ctx.json({ error: "Failed to get user info" });
          }

          const userInfoData = UserInfoResponse.parse(await userInfo.json());

          const botUserId = tokens.bot_user_id;

          let user: User | null = null;

          if (!link) {
            const existingUser = await ctx.context.internalAdapter.findUserByEmail(
              userInfoData.user.email,
            );
            if (existingUser) {
              await ctx.context.internalAdapter.updateUser(existingUser.user.id, {
                name: userInfoData.user.name,
                image: userInfoData.user.image_192,
              });
              user = existingUser.user;
            } else {
              user = await ctx.context.internalAdapter.createUser({
                email: userInfoData.user.email,
                name: userInfoData.user.name,
                image: userInfoData.user.image_192,
                emailVerified: true,
              });
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
                accountId: userInfoData.user.id,
                userId: user.id,
                accessToken: tokens.authed_user.access_token,
                scope: SLACK_USER_AUTH_SCOPES.join(","),
              });
            }

            // When a user is created, an estate and organization is created automatically via hooks
            // SO we can be sure that the user has only that estate
            const memberships = await db.query.organizationUserMembership.findFirst({
              where: eq(schema.organizationUserMembership.userId, user.id),
              columns: {},
              with: {
                organization: {
                  columns: {},
                  with: {
                    estates: {
                      columns: {
                        id: true,
                      },
                    },
                  },
                },
              },
            });

            if (!memberships) {
              // This should never happen
              return ctx.json({
                error: "Internal Error: Failed to get estate memberships, this should never happen",
              });
            }

            const session = await ctx.context.internalAdapter.createSession(user.id, ctx);
            await setSessionCookie(ctx, {
              session,
              user,
            });

            estateId = memberships.organization.estates[0].id;
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

          if (!estateId) {
            return ctx.json({ error: "Failed to get estate id" });
          }

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
            .onConflictDoNothing();

          return ctx.redirect(callbackURL);
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
