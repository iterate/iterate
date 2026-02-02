import { eq } from "drizzle-orm";
import { env } from "../../env.ts";
import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { getStripe } from "../integrations/stripe/stripe.ts";
import type { BillingEventTypes } from "../outbox/event-types.ts";
import { logger } from "../tag-logger.ts";

type BillingCheckoutPayload = BillingEventTypes["billing:checkout:initiated"];

export async function handleBillingCheckoutInitiated(
  payload: BillingCheckoutPayload,
  eventId: number,
): Promise<void> {
  const db = getDb();
  const stripe = getStripe();

  let account = await db.query.billingAccount.findFirst({
    where: eq(schema.billingAccount.organizationId, payload.organizationId),
  });

  if (!account) {
    const [newAccount] = await db
      .insert(schema.billingAccount)
      .values({ organizationId: payload.organizationId })
      .returning();
    account = newAccount;
  }

  if (!account) {
    throw new Error("Failed to create billing account");
  }

  if (!account.stripeCustomerId) {
    const customer = await stripe.customers.create({
      name: payload.organizationName,
      email: payload.createdByUserEmail ?? undefined,
      metadata: {
        organizationId: payload.organizationId,
        organizationSlug: payload.organizationSlug,
        createdByUserId: payload.createdByUserId,
      },
    });

    await db
      .update(schema.billingAccount)
      .set({ stripeCustomerId: customer.id })
      .where(eq(schema.billingAccount.id, account.id));

    account = { ...account, stripeCustomerId: customer.id };
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: account.stripeCustomerId!,
    line_items: [
      {
        price: env.STRIPE_METERED_PRICE_ID,
      },
    ],
    success_url: payload.successUrl,
    cancel_url: payload.cancelUrl,
    client_reference_id: payload.organizationId,
    subscription_data: {
      metadata: {
        organizationId: payload.organizationId,
        organizationSlug: payload.organizationSlug,
      },
    },
  });

  if (!session.url) {
    throw new Error("Failed to create checkout session");
  }

  await db
    .update(schema.outboxEvent)
    .set({
      payload: {
        ...payload,
        status: "ready",
        checkoutUrl: session.url,
        stripeCustomerId: account.stripeCustomerId,
        stripeCheckoutSessionId: session.id,
      },
    })
    .where(eq(schema.outboxEvent.id, eventId));

  logger.info("Created billing checkout session", {
    eventId,
    organizationId: payload.organizationId,
    sessionId: session.id,
  });
}
