import { betterAuth, APIError } from "better-auth";
import { admin, emailOTP } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { typeid } from "typeid-js";
import { minimatch } from "minimatch";
import { type DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { env, isNonProd, type CloudflareEnv } from "../../env.ts";
import { logger } from "../tag-logger.ts";

const TEST_EMAIL_PATTERN = /\+.*test@/i;
const TEST_OTP_CODE = "424242";

function parseEmailPatterns(value: string) {
  return value
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
}

function matchesEmailPattern(email: string, patterns: string[]) {
  return patterns.some((pattern) => minimatch(email, pattern));
}

function createAuth(db: DB, envParam: CloudflareEnv) {
  const allowSignupFromEmails = parseEmailPatterns(envParam.SIGNUP_ALLOWLIST);

  return betterAuth({
    baseURL: envParam.VITE_PUBLIC_URL,
    telemetry: { enabled: false },
    secret: envParam.BETTER_AUTH_SECRET,
    trustedOrigins: [envParam.VITE_PUBLIC_URL],
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
            return { data: user };
          },
        },
      },
    },
    plugins: [
      admin(),
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
                logger.info(`[EMAIL OTP] Would send OTP ${otp} to ${email}`);
                // TODO: Implement actual email sending (e.g., Resend, SendGrid, etc.)
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
