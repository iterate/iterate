import { randomInt } from "node:crypto";
import { betterAuth } from "better-auth";
import { admin, emailOTP } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { typeid } from "typeid-js";
import { stripe } from "@better-auth/stripe";
import { Resend } from "resend";
import { type DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { env, isNonProd } from "../../env.ts";
import { logger } from "../tag-logger.ts";
import { stripeClient } from "../integrations/stripe/stripe.ts";
import { integrationsPlugin, SLACK_USER_AUTH_SCOPES } from "./integrations.ts";
import { serviceAuthPlugin } from "./service-auth.ts";

// better-auth has an internal type that is not portable
// turning on declaration causes it to give you a portable type error
// so declaration is turned off, sdk builds work fine as tsdown handles it internally and doesn't rely on this type
// Possibly related https://github.com/better-auth/better-auth/issues/5122
export const getAuth = (db: DB) => {
  return betterAuth({
    baseURL: env.VITE_PUBLIC_URL,
    telemetry: { enabled: false },
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [
      env.VITE_PUBLIC_URL,
      // This is needed for the stripe webhook to work in dev mode
      ...(env.VITE_PUBLIC_URL.startsWith("http://localhost")
        ? [`https://${env.ITERATE_USER}.dev.iterate.com`]
        : []),
    ],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    user: {
      additionalFields: {
        debugMode: {
          type: "boolean",
          defaultValue: false,
        },
        isBot: {
          type: "boolean",
          defaultValue: false,
        },
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
        allowDifferentEmails: true,
      },
    },
    plugins: [
      admin(),
      ...(import.meta.env.VITE_ENABLE_EMAIL_OTP_SIGNIN
        ? [
            emailOTP({
              ...(isNonProd && {
                generateOTP: (o) => {
                  // magic: turns `bob+123456@nustom.com` into `123456`. or `alice+oct23.001001@nustom.com` into `001001`
                  const getSpecialEmailOtp = (email: string) => {
                    const [beforeAt, domain, ...rest] = email.split("@");
                    if (domain !== "nustom.com") return null;
                    if (rest.length !== 0) throw new Error("Invalid email " + email);
                    const plusDigits = beforeAt.split("+").at(-1)?.split(/\D/).at(-1);
                    return plusDigits?.match(/^\d{6}$/)?.[0];
                  };
                  return getSpecialEmailOtp(o.email) || randomInt(100000, 999999).toString();
                },
              }),
              async sendVerificationOTP(data) {
                logger.info("Verification OTP needs to be sent to email", data.email, data.otp);
                if (!env.RESEND_API_KEY) return;
                const resend = new Resend(env.RESEND_API_KEY);
                const result = await resend.emails.send({
                  from: `iterate <${env.RESEND_FROM_EMAIL || "noreply@iterate.com"}>`,
                  to: data.email,
                  subject: `sign in to iterate`,
                  html: `Your sign in code is ${data.otp}`,
                });
                if (result.error) logger.error("Error sending verification OTP", result.error);
              },
            }),
          ]
        : []),
      integrationsPlugin(),
      serviceAuthPlugin(),
      // We don't use any of the better auth stripe plugin's database schema or
      // subscription / plan management features
      // But it's handy just for the webhook handling and for creating a customer portal
      // session etc
      stripe({
        stripeClient,
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
        // we do this manually in the user creation hook
        createCustomerOnSignUp: false,
        onEvent: async (event) => {
          logger.debug("Stripe webhook received", event);
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
      slack: {
        clientId: env.SLACK_CLIENT_ID,
        clientSecret: env.SLACK_CLIENT_SECRET,
        scope: SLACK_USER_AUTH_SCOPES,
        redirectURI: `${env.VITE_PUBLIC_URL}/api/auth/callback/slack`,
      },
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 10 * 60, // seconds - see https://www.better-auth.com/docs/reference/options#session
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
export type AuthSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;
export type AuthUser = NonNullable<AuthSession>["user"];
