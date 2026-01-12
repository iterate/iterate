import Stripe from "stripe";
import { env } from "../../../env.ts";

let stripeInstance: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeInstance) {
    stripeInstance = new Stripe(env.STRIPE_SECRET_KEY);
  }
  return stripeInstance;
}

export function getStripeWithKey(secretKey: string): Stripe {
  return new Stripe(secretKey);
}
