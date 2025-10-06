import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { publicProcedure, createRouter } from "../trpc.ts";
import { db } from "../../db/client.ts";
import { domains, purchases } from "../../db/schema.ts";
import { stripe } from "../../stripe.ts";
import { sendDomainPurchaseEmail } from "../../email.ts";
import { env } from "../../../env.ts";

export const webhooksRouter = createRouter({
  stripeWebhook: publicProcedure
    .meta({ description: "Handle Stripe webhook events" })
    .input(
      z.object({
        body: z.string(),
        signature: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const webhookSecret = env.STRIPE_GARPLECOM_WEBHOOK_SIGNING_SECRET_CHECKOUT_COMPLETED;
      if (!webhookSecret) {
        throw new Error("Stripe webhook signing secret is not set in environment variables.");
      }

      try {
        const event = stripe.webhooks.constructEvent(input.body, input.signature, webhookSecret);

        if (event.type === "checkout.session.completed") {
          const session = event.data.object;
          const domainId = session.metadata?.domainId;

          if (!domainId) {
            throw new Error("No domain ID in session metadata");
          }

          // Get domain details
          const domain = await db.select().from(domains).where(eq(domains.id, domainId)).limit(1);

          if (!domain[0]) {
            throw new Error("Domain not found");
          }

          if (domain[0].purchased) {
            console.log("Domain already purchased, skipping");
            return { success: true };
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
          const customerEmail = session.customer_details!.email || "sales@garple.com";
          await db.insert(purchases).values({
            domainId,
            stripeCheckoutSessionId: session.id,
            customerEmail,
            paymentStatus: "completed",
          });

          await sendDomainPurchaseEmail(domainId, customerEmail);

          console.log(
            `Domain ${domain[0].nameWithTld} purchased and email sent to ${customerEmail}`,
          );

          return { success: true };
        }

        return { success: true };
      } catch (error) {
        console.error("Webhook error:", error);
        throw error;
      }
    }),
});
