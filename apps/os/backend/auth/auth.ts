import { betterAuth, APIError } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { admin, emailOTP } from "better-auth/plugins";
import { oneTimeToken } from "better-auth/plugins/one-time-token";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { typeid } from "typeid-js";
import { minimatch } from "minimatch";
import { z } from "zod/v4";
import { type DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { env, isNonProd, waitUntil, type CloudflareEnv } from "../../env.ts";
import { logger } from "../tag-logger.ts";
import { captureServerEvent } from "../lib/posthog.ts";
import { createResendClient, sendEmail } from "../integrations/resend/resend.ts";

const TEST_EMAIL_PATTERN = /\+.*test@/i;
const TEST_OTP_CODE = "424242";

/** Generate a DiceBear avatar URL using a hash of the user's email as seed */
function generateDefaultAvatar(email: string): string {
  const normalized = email.trim().toLowerCase();
  // Simple hash to avoid exposing email in URL
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash << 5) - hash + normalized.charCodeAt(i);
    hash |= 0;
  }
  return `https://api.dicebear.com/9.x/notionists/svg?seed=${Math.abs(hash).toString(36)}`;
}

function parseEmailPatterns(value: string) {
  return value
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
}

function matchesEmailPattern(email: string, patterns: string[]) {
  return patterns.some((pattern) => minimatch(email, pattern));
}

function parseHostMatchers(value: string) {
  return value
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
}

function matchesHostMatcher(hostname: string, patterns: string[]) {
  return patterns.some((pattern) =>
    minimatch(hostname, pattern, {
      nocase: true,
      dot: true,
      noext: false,
      noglobstar: false,
    }),
  );
}

function normalizeProjectIngressProxyRedirectPath(rawPath: string | undefined): string {
  if (!rawPath) return "/";
  try {
    const parsed = new URL(rawPath, "https://project-ingress-proxy.local");
    if (parsed.origin !== "https://project-ingress-proxy.local") return "/";
    const normalizedPath = `${parsed.pathname}${parsed.search}`;
    if (!normalizedPath.startsWith("/")) return "/";
    return normalizedPath;
  } catch {
    return "/";
  }
}

function projectIngressProxyOneTimeTokenExchangePlugin() {
  return {
    id: "project-ingress-proxy-one-time-token-exchange",
    endpoints: {
      exchangeProjectIngressProxyOneTimeToken: createAuthEndpoint(
        "/project-ingress-proxy/one-time-token/exchange",
        {
          method: "GET",
          query: z.object({
            token: z.string().min(1),
            redirectPath: z.string().optional(),
          }),
        },
        async (ctx) => {
          const verificationValue = await ctx.context.internalAdapter.findVerificationValue(
            `one-time-token:${ctx.query.token}`,
          );
          if (!verificationValue) {
            throw new APIError("BAD_REQUEST", { message: "Invalid one-time token" });
          }
          await ctx.context.internalAdapter.deleteVerificationValue(verificationValue.id);
          if (verificationValue.expiresAt < new Date()) {
            throw new APIError("BAD_REQUEST", { message: "One-time token expired" });
          }
          const verifiedSession = await ctx.context.internalAdapter.findSession(
            verificationValue.value,
          );
          if (!verifiedSession) {
            throw new APIError("BAD_REQUEST", { message: "Session not found for one-time token" });
          }
          await setSessionCookie(ctx, verifiedSession);
          throw ctx.redirect(normalizeProjectIngressProxyRedirectPath(ctx.query.redirectPath));
        },
      ),
    },
  };
}

function createAuth(db: DB, envParam: CloudflareEnv) {
  const allowSignupFromEmails = parseEmailPatterns(envParam.SIGNUP_ALLOWLIST);
  const ingressHostMatchers = parseHostMatchers(envParam.PROJECT_INGRESS_PROXY_HOST_MATCHERS);
  const baseHostname = URL.canParse(envParam.VITE_PUBLIC_URL)
    ? new URL(envParam.VITE_PUBLIC_URL).hostname
    : null;
  const canUseCrossSubdomainCookies =
    !!baseHostname && baseHostname !== "localhost" && baseHostname !== "127.0.0.1";

  return betterAuth({
    baseURL: envParam.VITE_PUBLIC_URL,
    telemetry: { enabled: false },
    secret: envParam.BETTER_AUTH_SECRET,
    trustedOrigins: (request) => {
      const trustedOrigins = [envParam.VITE_PUBLIC_URL];
      // In non-prod, allow any localhost/127.0.0.1 origin (any port)
      if (isNonProd) {
        const origin = request?.headers.get("origin");
        if (origin) {
          try {
            const url = new URL(origin);
            if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
              trustedOrigins.push(origin);
              return [...new Set(trustedOrigins)];
            }
          } catch {
            // Invalid URL, fall through to default
          }
        }
      }

      const origin = request?.headers.get("origin");
      if (origin) {
        try {
          const originHost = new URL(origin).hostname.toLowerCase();
          if (matchesHostMatcher(originHost, ingressHostMatchers)) {
            trustedOrigins.push(origin);
          }
        } catch {
          // Ignore malformed origin
        }
      }

      return [...new Set(trustedOrigins)];
    },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const email = user.email.trim().toLowerCase();
            if (!matchesEmailPattern(email, allowSignupFromEmails)) {
              throw new APIError("FORBIDDEN", {
                message: "Sign up is not available for this email address",
              });
            }
            // Set default DiceBear avatar if no image provided (e.g., email OTP signup)
            const image = user.image || generateDefaultAvatar(email);
            return { data: { ...user, image } };
          },
          after: async (user) => {
            logger.info("User signed up", { userId: user.id, email: user.email });
            // Track user_signed_up event in PostHog using waitUntil to ensure delivery
            waitUntil(
              captureServerEvent(envParam, {
                distinctId: user.id,
                event: "user_signed_up",
                properties: {
                  signup_method: "oauth", // Could be refined based on context
                  // $set creates/updates person properties so the event is linked to a person profile
                  $set: {
                    email: user.email,
                    name: user.name,
                  },
                },
              }).catch((error) => {
                logger.error("Failed to track user_signed_up event", { error, userId: user.id });
              }),
            );
          },
        },
      },
    },
    plugins: [
      admin(),
      oneTimeToken({
        disableClientRequest: true,
        storeToken: "plain",
      }),
      projectIngressProxyOneTimeTokenExchangePlugin(),
      ...(envParam.VITE_ENABLE_EMAIL_OTP_SIGNIN === "true"
        ? [
            emailOTP({
              otpLength: 6,
              expiresIn: 300,
              generateOTP: ({ email }) => {
                if (isNonProd && TEST_EMAIL_PATTERN.test(email)) {
                  return TEST_OTP_CODE;
                }
                return undefined;
              },
              sendVerificationOTP: async ({ email, otp }) => {
                if (isNonProd && TEST_EMAIL_PATTERN.test(email)) {
                  logger.info(
                    `[DEV] Skipping email for test address: ${email}. Use OTP: ${TEST_OTP_CODE}`,
                  );
                  return;
                }

                // Send OTP via Resend
                // Use stage prefix in from address for routing (e.g., noreply+dev-mmkal@mail.iterate.com)
                const client = createResendClient(envParam.RESEND_BOT_API_KEY);
                const result = await sendEmail(client, {
                  from: `Iterate <noreply+${envParam.VITE_APP_STAGE}@${envParam.RESEND_BOT_DOMAIN}>`,
                  to: email,
                  subject: `Your verification code: ${otp}`,
                  text: `Your verification code is: ${otp}\n\nThis code expires in 5 minutes.\n\nIf you didn't request this code, you can safely ignore this email.`,
                  html: `
                    <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
                      <h2 style="color: #333; margin-bottom: 20px;">Verification Code</h2>
                      <p style="color: #666; margin-bottom: 20px;">Your verification code is:</p>
                      <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; margin-bottom: 20px;">
                        <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #333;">${otp}</span>
                      </div>
                      <p style="color: #999; font-size: 14px;">This code expires in 5 minutes.</p>
                      <p style="color: #999; font-size: 14px;">If you didn't request this code, you can safely ignore this email.</p>
                    </div>
                  `,
                });

                if ("error" in result) {
                  logger.error("[EMAIL OTP] Failed to send OTP email", {
                    email,
                    error: result.error,
                  });
                  throw new Error(`Failed to send verification email: ${result.error}`);
                }

                logger.info("[EMAIL OTP] Sent OTP email", { email, emailId: result.id });
              },
            }),
          ]
        : []),
    ],
    socialProviders: {
      google: {
        scope: [
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/userinfo.profile",
          "openid",
        ],
        clientId: envParam.GOOGLE_CLIENT_ID,
        clientSecret: envParam.GOOGLE_CLIENT_SECRET,
      },
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 10 * 60, // 10 minutes
      },
    },
    advanced: {
      ...(canUseCrossSubdomainCookies
        ? {
            crossSubDomainCookies: {
              enabled: true,
              domain: baseHostname,
            },
          }
        : {}),
      database: {
        generateId: (opts) => {
          const map = {
            account: "acc",
            session: "ses",
            user: "usr",
            verification: "ver",
          } as Record<string, string>;

          return typeid(map[opts.model] ?? opts.model).toString();
        },
      },
    },
  });
}

export const getAuth = (db: DB) => createAuth(db, env);

export const getAuthWithEnv = (db: DB, envParam: CloudflareEnv) => createAuth(db, envParam);

export type Auth = ReturnType<typeof getAuth>;
export type AuthSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;
export type AuthUser = NonNullable<AuthSession>["user"];
