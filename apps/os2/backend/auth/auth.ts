import { betterAuth } from "better-auth";
import { admin, emailOTP } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { typeid } from "typeid-js";
import { type DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { env, isNonProd } from "../../env.ts";
import { logger } from "../tag-logger.ts";

const TEST_EMAIL_PATTERN = /\+.*test@/i;
const TEST_OTP_CODE = "424242";

export const getAuth = (db: DB) => {
  return betterAuth({
    baseURL: env.VITE_PUBLIC_URL,
    telemetry: { enabled: false },
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.VITE_PUBLIC_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    plugins: [
      admin(),
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
    ],
    socialProviders: {
      google: {
        scope: [
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/userinfo.profile",
          "openid",
        ],
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
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
};

export type Auth = ReturnType<typeof getAuth>;
export type AuthSession =
  | {
      user: {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        email: string;
        emailVerified: boolean;
        name: string;
        image?: string | null;
        role?: string | null;
        banned?: boolean | null;
        banReason?: string | null;
        banExpires?: Date | null;
      };
      session: {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        userId: string;
        expiresAt: Date;
        token: string;
        ipAddress?: string | null;
        userAgent?: string | null;
        impersonatedBy?: string | null;
      };
    }
  | null;
export type AuthUser = NonNullable<AuthSession>["user"];
