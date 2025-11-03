import Stripe from "stripe";
import { env } from "../env.ts";
const apiKey = env.STRIPE_GARPLECOM_SECRET_KEY;
if (!apiKey) {
  throw new Error("Stripe API key is not set in environment variables.");
}

const stripe = new Stripe(apiKey, {
  apiVersion: "2025-10-29.clover",
});

export async function createCheckoutSession(
  domain: { id: string; nameWithTld: string; amountInMinorUnits: number; currency: string },
  options: {
    successUrl: string;
    cancelUrl: string;
  },
) {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: domain.currency.toLowerCase(),
          product_data: {
            name: domain.nameWithTld,
            description: `Domain name: ${domain.nameWithTld}`,
          },
          unit_amount: domain.amountInMinorUnits,
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    success_url: options.successUrl,
    cancel_url: options.cancelUrl,
    metadata: {
      domainId: domain.id,
    },
  });

  return session;
}

export async function getSession(sessionId: string) {
  return await stripe.checkout.sessions.retrieve(sessionId);
}

export { stripe };
