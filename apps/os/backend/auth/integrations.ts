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
import type { Variables } from "../worker";
import * as schema from "../db/schema.ts";
import { env, type CloudflareEnv } from "../../env.ts";
import { IterateAgent } from "../agent/iterate-agent.ts";
import { SlackAgent } from "../agent/slack-agent.ts";
import { syncSlackUsersInBackground } from "../integrations/slack/slack.ts";
import { MCPOAuthState, SlackBotOAuthState } from "./oauth-state-schemas.ts";

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
            console.error("Estate not found or user not authorized", {
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
                  requiresAuth: true,
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

            waitUntil(syncSlackUsersInBackground(db, tokens.access_token));

            const existingSlackTeam = await db.query.providerEstateMapping.findFirst({
              where: and(
                eq(schema.providerEstateMapping.providerId, "slack-bot"),
                eq(schema.providerEstateMapping.externalId, tokens.team?.id),
              ),
              columns: {},
              with: {
                internalEstate: {
                  columns: {
                    id: true,
                  },
                  with: {
                    organization: {
                      columns: {
                        id: true,
                      },
                    },
                  },
                },
              },
            });

            // If the slack team is already linked to an estate, add the user to that estate too
            if (existingSlackTeam) {
              await db.insert(schema.organizationUserMembership).values({
                organizationId: existingSlackTeam?.internalEstate.organization.id,
                userId: user.id,
                role: "member",
              });
              estateId = existingSlackTeam?.internalEstate.id;
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

            // If the estate id is not set, set it to the first estate in the organization
            if (!estateId) {
              estateId = memberships.organization.estates[0].id;
            }
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
              externalId: tokens.team?.id,
              providerId: "slack-bot",
              providerMetadata: {
                botUserId,
                team: tokens.team,
              },
            })
            .onConflictDoNothing();

          if (!callbackURL) {
            return ctx.redirect(import.meta.env.VITE_PUBLIC_URL);
          }

          return ctx.redirect(callbackURL);
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
