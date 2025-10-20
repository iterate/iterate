import { betterAuth } from "better-auth";
import { admin, emailOTP } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { typeid } from "typeid-js";
import { stripe } from "@better-auth/stripe";
import { Resend } from "resend";
import { type DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { env } from "../../env.ts";
import { logger } from "../tag-logger.ts";
import { stripeClient } from "../integrations/stripe/stripe.ts";
import { integrationsPlugin } from "./integrations.ts";
import { serviceAuthPlugin } from "./service-auth.ts";

export const getAuth = (db: DB) =>
  betterAuth({
    baseURL: env.VITE_PUBLIC_URL,
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
    // for now, we only want to enable email and password login if we know we need it for testing
    ...(import.meta.env.VITE_ENABLE_TEST_ADMIN_USER
      ? { emailAndPassword: { enabled: true } }
      : ({} as never)), // need to cast to never to make typescript think we can call APIs like `auth.api.createUser` - but this will fail at runtime if we try to use it in production
    plugins: [
      admin(),
      emailOTP({
        async sendVerificationOTP(data) {
          logger.info("Verification OTP needs to be sent to email", data.email, data.otp);
          if (!import.meta.env.RESEND_API_KEY) return;
          const resend = new Resend(import.meta.env.RESEND_API_KEY);
          const result = await resend.emails.send({
            from: `iterate <${import.meta.env.RESEND_FROM_EMAIL}>`,
            to: data.email,
            subject: `sign in to iterate`,
            html: `Your sign in code is ${data.otp}`,
          });
          if (result.error) logger.error("Error sending verification OTP", result.error);
        },
      }),
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

export type Auth = ReturnType<typeof getAuth>;
export type AuthSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;
