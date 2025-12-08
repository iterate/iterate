import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { fetch } from "../../fetch.ts";
import type { DB } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { env } from "../../../env.ts";
import { logger } from "../../tag-logger.ts";

export const stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-10-29.clover",
});

const V2_STRIPE_VERSION = "2025-09-30.preview";

type Organization = {
  id: string;
  name: string;
  stripeCustomerId: string | null;
};

type User = {
  id: string;
  name: string;
  email: string;
};

type StripeV2Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/**
 * Makes a JSON request to the Stripe v2 API
 */
async function stripeV2JSON<T = unknown>(
  method: StripeV2Method,
  path: string,
  payload?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Stripe-Version": V2_STRIPE_VERSION,
  };

  const init: RequestInit = { method, headers };

  if (payload !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(payload);
  }

  const response = await fetch(`https://api.stripe.com${path}`, init);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Stripe API error: ${response.status} ${response.statusText} - ${body}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Creates a Stripe customer for the organization
 */
export async function createStripeCustomer(organization: Organization, user: User) {
  const customer = await stripeClient.customers.create({
    email: user.email,
    name: organization.name,
    description: `Owned by ${user.name} <${user.email}>`,
    metadata: {
      userId: user.id,
      organizationId: organization.id,
    },
  });

  logger.debug("Stripe customer created", customer);
  return customer;
}

type CadenceInterval = "month" | "year";

/**
 * Subscribes a customer to a pricing plan with the given cadence
 * Based on Stripe's Billing v2 API
 * And specifically this ruby script in #ext-stripe
 * https://iterate-com.slack.com/archives/C09J7C445A9/p1759503324919989
 */
export async function subscribeCustomerToPricingPlan(
  customerId: string,
  pricingPlanId: string,
  cadenceInterval: CadenceInterval = "month",
) {
  logger.debug("Starting subscription flow", { customerId, pricingPlanId, cadenceInterval });

  // 1) Resolve pricing plan version
  const plan = await stripeV2JSON<{ latest_version: string }>(
    "GET",
    `/v2/billing/pricing_plans/${pricingPlanId}`,
  );
  const planVersion = plan.latest_version;

  if (!planVersion) {
    throw new Error("Could not determine pricing_plan_version");
  }

  logger.debug("Resolved pricing plan", { id: pricingPlanId, version: planVersion });

  // 2) Resolve payment method (optional)
  const paymentMethods = await stripeClient.customers.listPaymentMethods(customerId);
  const paymentMethod = paymentMethods.data[0];

  // 3) Create Billing Profile
  const billingProfilePayload: { customer: string; default_payment_method?: string } = {
    customer: customerId,
  };

  if (paymentMethod) {
    billingProfilePayload.default_payment_method = paymentMethod.id;
  }

  const billingProfile = await stripeV2JSON<{ id: string }>(
    "POST",
    "/v2/billing/profiles",
    billingProfilePayload,
  );
  logger.debug("Created billing profile", billingProfile);

  // 4) Create Cadence
  const today = new Date();
  const dayOfMonth = today.getDate();

  const cadenceBillingCycle =
    cadenceInterval === "month"
      ? {
          type: "month",
          interval_count: 1,
          month: { day_of_month: dayOfMonth, time: { hour: 0, minute: 0, second: 0 } },
        }
      : {
          type: "year",
          interval_count: 1,
          year: {
            month_of_year: today.getMonth() + 1, // JS months are 0-indexed
            day_of_month: dayOfMonth,
            time: { hour: 0, minute: 0, second: 0 },
          },
        };

  const cadence = await stripeV2JSON<{ id: string }>("POST", "/v2/billing/cadences", {
    payer: {
      billing_profile: billingProfile.id,
    },
    billing_cycle: cadenceBillingCycle,
  });
  logger.debug("Created cadence", cadence);

  // 5) Create Billing Intent with subscribe action
  const billingIntent = await stripeV2JSON<{ id: string }>("POST", "/v2/billing/intents", {
    cadence: cadence.id,
    currency: "usd",
    actions: [
      {
        type: "subscribe",
        subscribe: {
          type: "pricing_plan_subscription_details",
          billing_details: {
            proration_behavior: "no_adjustment",
          },
          effective_at: {
            type: "current_billing_period_start",
          },
          pricing_plan_subscription_details: {
            pricing_plan: pricingPlanId,
            pricing_plan_version: planVersion,
            component_configurations: [],
          },
        },
      },
    ],
  });
  logger.debug("Created billing intent", billingIntent);

  // 6) Reserve the billing intent
  const reserved = await stripeV2JSON<{ amount_details: { total: number } }>(
    "POST",
    `/v2/billing/intents/${billingIntent.id}/reserve`,
    {},
  );
  logger.debug("Reserved billing intent", reserved);

  let committed;

  // If there's a payment method, create and confirm a payment intent
  // Otherwise, the customer will receive an invoice via email
  if (paymentMethod) {
    // 7) Create a payment intent
    const paymentIntent = await stripeClient.paymentIntents.create({
      amount: reserved.amount_details.total,
      currency: "usd",
      customer: customerId,
      payment_method: paymentMethod.id,
    });
    logger.debug("Created payment intent", paymentIntent);

    // 8) Confirm the payment intent
    const confirmedPaymentIntent = await stripeClient.paymentIntents.confirm(paymentIntent.id, {
      return_url: env.VITE_PUBLIC_URL,
    });
    logger.debug("Confirmed payment intent", confirmedPaymentIntent);

    // 9) Commit the billing intent
    committed = await stripeV2JSON("POST", `/v2/billing/intents/${billingIntent.id}/commit`, {
      payment_intent: confirmedPaymentIntent.id,
    });
  } else {
    // 9) Commit the billing intent without payment (will send invoice)
    committed = await stripeV2JSON("POST", `/v2/billing/intents/${billingIntent.id}/commit`, {});
  }

  logger.debug("Committed billing intent", committed);

  return {
    pricingPlan: {
      id: pricingPlanId,
      version: planVersion,
    },
    cadence,
    billingIntent,
    reserved,
    committed,
  };
}

/**
 * Creates a Stripe customer for the organization and subscribes them to the pricing plan.
 * Also updates the organization record with the Stripe customer ID.
 * This is the complete flow used when a new organization is created.
 */
export async function createStripeCustomerAndSubscriptionForOrganization(
  db: DB,
  organization: Organization,
  user: User,
) {
  if (organization.stripeCustomerId) {
    logger.debug("Stripe customer already exists for organization - skipping", {
      organizationId: organization.id,
    });
    return;
  }

  try {
    // Create the customer first
    const customer = await createStripeCustomer(organization, user);

    // Immediately save the customer ID to the database
    await db
      .update(schema.organization)
      .set({
        stripeCustomerId: customer.id,
      })
      .where(eq(schema.organization.id, organization.id));

    // Then subscribe the customer to the pricing plan
    await subscribeCustomerToPricingPlan(customer.id, env.STRIPE_PRICING_PLAN_ID, "month");

    return customer;
  } catch (error) {
    logger.error("Failed to create Stripe customer and subscription", error);
    throw error;
  }
}

/**
 * Track token usage with Stripe meter events
 */
export async function trackTokenUsageInStripe(params: {
  stripeCustomerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const { stripeCustomerId, model, inputTokens, outputTokens } = params;

  const inputPayload = {
    event_name: "token-billing-tokens",
    payload: {
      stripe_customer_id: stripeCustomerId,
      model: `openai/${model}`,
      token_type: "input",
      value: `${inputTokens}`,
    },
  };

  const outputPayload = {
    event_name: "token-billing-tokens",
    payload: {
      stripe_customer_id: stripeCustomerId,
      model: `openai/${model}`,
      token_type: "output",
      value: `${outputTokens}`,
    },
  };

  const payloads = [inputPayload, outputPayload];

  const results = await Promise.allSettled([
    stripeClient.v2.billing.meterEvents.create(inputPayload),
    stripeClient.v2.billing.meterEvents.create(outputPayload),
  ]);

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.error("Stripe meter event failed", {
        error: result.reason,
        payload: payloads[index],
      });
    }
  });
}
