import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { env } from "../env.ts";
import { stripe } from "./stripe.ts";
import { db } from "./db/client.ts";
import { domains, purchases } from "./db/schema.ts";
import { sendDomainPurchaseEmail } from "./email.ts";

export async function handleStripeWebhook(c: Context) {
  console.log("Received Stripe webhook");

  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "Missing stripe signature" }, 400);
  }

  let event: Stripe.Event;
  try {
    const body = await c.req.text();
    const endpointSecret = env.STRIPE_GARPLECOM_WEBHOOK_SIGNING_SECRET_CHECKOUT_COMPLETED;
    if (!endpointSecret) {
      throw new Error("Missing STRIPE_GARPLECOM_WEBHOOK_SIGNING_SECRET_CHECKOUT_COMPLETED");
    }
    event = await stripe.webhooks.constructEventAsync(body, signature, endpointSecret);
  } catch (error) {
    console.error("Webhook signature verification failed:", error);
    return c.json({ error: "Webhook signature verification failed" }, 400);
  }

  console.log("Stripe event type:", event.type);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const domainId = session.metadata?.domainId;
    const customerEmail = session.customer_details?.email;

    if (!domainId || !customerEmail) {
      console.error("Missing domain ID or customer email in webhook", { domainId, customerEmail });
      return c.json({ error: "Missing required data" }, 400);
    }

    try {
      // Check if domain exists and is still available
      const domain = await db.select().from(domains).where(eq(domains.id, domainId)).limit(1);

      if (!domain[0]) {
        console.error("Domain not found:", domainId);
        return c.json({ error: "Domain not found" }, 400);
      }

      if (domain[0].purchased) {
        console.warn("Domain already purchased:", domainId);
        return c.json({ message: "Domain already purchased" }, 200);
      }

      // Mark domain as purchased
      await db
        .update(domains)
        .set({
          purchased: true,
          purchasedAt: new Date(),
        })
        .where(eq(domains.id, domainId));

      // Create purchase record
      await db.insert(purchases).values({
        domainId,
        stripeCheckoutSessionId: session.id,
        customerEmail,
        paymentStatus: "completed",
      });

      // Send email with auth code
      await sendDomainPurchaseEmail(domainId, customerEmail);

      console.log("Domain purchase completed successfully:", {
        domainId,
        customerEmail,
        sessionId: session.id,
      });

      return c.json({ message: "Purchase completed successfully" }, 200);
    } catch (error) {
      console.error("Error processing webhook:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  }

  return c.json({ message: "Unsupported Webhook Event Type" }, 400);
}
