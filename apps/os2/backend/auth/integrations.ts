import { type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/plugins";
import { sessionMiddleware } from "better-auth/api";
import { createAuthorizationURL } from "better-auth/oauth2";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod/v4";
import { generateRandomString } from "better-auth/crypto";
import { getContext } from "hono/context-storage";
import { eq, and } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import type { Variables } from "../worker.ts";
import * as schema from "../db/schema.ts";
import type { CloudflareEnv } from "../../env.ts";
import { generateSlugFromEmail } from "../utils/slug.ts";
import { SlackBotOAuthState, GoogleOAuthState } from "./oauth-state-schemas.ts";

export const SLACK_BOT_SCOPES = [
  "channels:history",
  "channels:join",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "users.profile:read",
  "users:read",
  "users:read.email",
  "assistant:write",
];

export const SLACK_USER_AUTH_SCOPES = ["openid", "profile", "email"];

export const GOOGLE_INTEGRATION_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "openid",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
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
            projectId: z.string(),
            callbackURL: z.string(),
          }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const { projectId, callbackURL } = ctx.body;
          const session = ctx.context.session;

          const {
            env,
            var: { db },
          } = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();

          const projectResult = await db.query.project.findFirst({
            where: eq(schema.project.id, projectId),
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

          if (!projectResult) {
            throw new Error("You are not a member of this project");
          }

          const state = generateRandomString(32);
          const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

          const oauthStateData = {
            estateId: projectId,
            link: {
              userId: session.user.id,
              email: session.user.email,
            },
            callbackUrl: callbackURL,
          } satisfies SlackBotOAuthState;

          await ctx.context.internalAdapter.createVerificationValue({
            expiresAt,
            identifier: state,
            value: JSON.stringify(oauthStateData),
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
          query: z.union([
            z.object({
              error: z.string(),
              error_description: z.string().optional(),
            }),
            z.object({
              code: z.string(),
              state: z.string(),
            }),
          ]),
        },
        async (ctx) => {
          if ("error" in ctx.query) {
            const url = new URL(`${import.meta.env.VITE_PUBLIC_URL}/api/auth/error`);
            url.searchParams.set("error", ctx.query.error);
            if (ctx.query.error_description)
              url.searchParams.set("error_description", ctx.query.error_description);
            throw ctx.redirect(url.toString());
          }

          const value = await ctx.context.internalAdapter.findVerificationValue(ctx.query.state);
          if (!value) {
            return ctx.json({ error: "Invalid state" });
          }

          const parsedState = SlackBotOAuthState.parse(JSON.parse(value.value));
          const { link, callbackUrl: callbackURL } = parsedState;
          let projectId = parsedState.estateId;

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
            !tokens.authed_user.id ||
            !tokens.bot_user_id ||
            !tokens.team?.id
          ) {
            return ctx.json({ error: "Failed to get tokens", details: tokens.error });
          }

          const userSlackClient = new WebClient(tokens.authed_user.access_token);
          const userInfo = await userSlackClient.openid.connect.userInfo({});

          if (!userInfo || !userInfo.ok || !userInfo.email || !userInfo.sub) {
            return ctx.json({ error: "Failed to get user info", details: userInfo.error });
          }

          const botUserId = tokens.bot_user_id;

          let user:
            | NonNullable<
                Awaited<ReturnType<typeof ctx.context.internalAdapter.findUserByEmail>>
              >["user"]
            | null = null;

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

              const slug = generateSlugFromEmail(userInfo.email);
              const org = await db
                .insert(schema.organization)
                .values({
                  name: slug,
                  slug,
                })
                .returning();

              if (org[0]) {
                await db.insert(schema.organizationUserMembership).values({
                  organizationId: org[0].id,
                  userId: user.id,
                  role: "owner",
                });

                const newProject = await db
                  .insert(schema.project)
                  .values({
                    name: "Default Project",
                    slug: "default",
                    organizationId: org[0].id,
                  })
                  .returning();

                if (newProject[0]) {
                  projectId = newProject[0].id;
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
                accountId: tokens.authed_user.id,
                userId: user.id,
                accessToken: tokens.authed_user.access_token,
                scope: SLACK_USER_AUTH_SCOPES.join(","),
              });
            }

            const session = await ctx.context.internalAdapter.createSession(user.id);
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

          const existingBotAccount = await db.query.account.findFirst({
            where: and(
              eq(schema.account.userId, user.id),
              eq(schema.account.providerId, "slack-bot"),
            ),
          });

          let botAccount: typeof existingBotAccount = existingBotAccount;
          if (botAccount) {
            await ctx.context.internalAdapter.updateAccount(botAccount.id, {
              accessToken: tokens.access_token,
              scope: SLACK_BOT_SCOPES.join(","),
              accountId: botUserId,
            });
          } else {
            const createdAccount = await ctx.context.internalAdapter.createAccount({
              providerId: "slack-bot",
              userId: user.id,
              accessToken: tokens.access_token,
              scope: SLACK_BOT_SCOPES.join(","),
              accountId: botUserId,
            });
            if (!createdAccount) {
              return ctx.json({ error: "Failed to create bot account" });
            }
            botAccount = {
              ...createdAccount,
              accessToken: createdAccount.accessToken ?? null,
              password: createdAccount.password ?? null,
              refreshToken: createdAccount.refreshToken ?? null,
              idToken: createdAccount.idToken ?? null,
              accessTokenExpiresAt: createdAccount.accessTokenExpiresAt ?? null,
              refreshTokenExpiresAt: createdAccount.refreshTokenExpiresAt ?? null,
            };
          }

          if (projectId && botAccount) {
            await db
              .insert(schema.projectAccountPermission)
              .values({
                accountId: botAccount.id,
                projectId,
              })
              .onConflictDoNothing();
          }

          return ctx.redirect(callbackURL || import.meta.env.VITE_PUBLIC_URL);
        },
      ),

      callbackGoogle: createAuthEndpoint(
        "/integrations/callback/google",
        {
          method: "GET",
          query: z.object({
            error: z.string().optional(),
            error_description: z.string().optional(),
            code: z.string(),
            state: z.string(),
          }),
        },
        async (ctx) => {
          const value = await ctx.context.internalAdapter.findVerificationValue(ctx.query.state);

          if (!value) {
            return ctx.json({ error: "Invalid state" });
          }

          const parsedState = GoogleOAuthState.parse(JSON.parse(value.value));
          const { link, callbackUrl: callbackURL } = parsedState;

          const { env } = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();

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

          if (!callbackURL) {
            return ctx.redirect(import.meta.env.VITE_PUBLIC_URL);
          }

          return ctx.redirect(callbackURL);
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
