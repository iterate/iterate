import { z } from "zod/v4";
import { eq, and, like, type SQL } from "drizzle-orm";
import { publicProcedure, createRouter } from "../trpc.ts";
import { db } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { createCheckoutSession } from "../../stripe.ts";

export const domainsRouter = createRouter({
  list: publicProcedure
    .meta({ description: "Get all domains with optional filters" })
    .input(
      z
        .object({
          nameFilter: z.string().optional(),
          availabilityFilter: z.enum(["available", "sold", "both"]).default("both"),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const filters = input || { availabilityFilter: "both" as const };

      const baseQuery = db.select().from(schema.domains);

      const conditions: SQL[] = [];

      if (filters.nameFilter && filters.nameFilter.length > 0) {
        conditions.push(like(schema.domains.nameWithTld, `%${filters.nameFilter}%`));
      }

      if (filters.availabilityFilter === "available") {
        conditions.push(eq(schema.domains.purchased, false));
      } else if (filters.availabilityFilter === "sold") {
        conditions.push(eq(schema.domains.purchased, true));
      }

      const query =
        conditions.length > 0
          ? baseQuery.where(conditions.length === 1 ? conditions[0]! : and(...conditions))
          : baseQuery;

      const result = await query.orderBy(schema.domains.nameWithTld);
      return result;
    }),

  getByName: publicProcedure
    .meta({ description: "Get a specific domain by name" })
    .input(z.object({ nameWithTld: z.string() }))
    .query(async ({ input }) => {
      const result = await db
        .select()
        .from(schema.domains)
        .where(eq(schema.domains.nameWithTld, input.nameWithTld))
        .limit(1);

      return result[0] || null;
    }),

  createStripeCheckoutSession: publicProcedure
    .meta({ description: "Create a Stripe checkout session for a domain" })
    .input(
      z.object({
        domainId: z.string(),
        successUrl: z.string(),
        cancelUrl: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      // Get domain details
      const domain = await db
        .select()
        .from(schema.domains)
        .where(eq(schema.domains.id, input.domainId))
        .limit(1);

      if (!domain[0]) {
        throw new Error("Domain not found");
      }

      if (domain[0].purchased) {
        throw new Error("Domain is already purchased");
      }

      const session = await createCheckoutSession(domain[0], {
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      });

      return {
        sessionId: session.id,
        checkoutUrl: session.url,
      };
    }),

  completePurchase: publicProcedure
    .meta({ description: "Complete a domain purchase after successful payment" })
    .input(
      z.object({
        domainId: z.string(),
        stripeCheckoutSessionId: z.string(),
        customerEmail: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      // Check if domain is still available
      const domain = await db
        .select()
        .from(schema.domains)
        .where(eq(schema.domains.id, input.domainId))
        .limit(1);

      if (!domain[0]) {
        throw new Error("Domain not found");
      }

      if (domain[0].purchased) {
        throw new Error("Domain is already purchased");
      }

      // Mark domain as purchased
      await db
        .update(schema.domains)
        .set({
          purchased: true,
          purchasedAt: new Date(),
        })
        .where(eq(schema.domains.id, input.domainId));

      // Create purchase record
      await db.insert(schema.purchases).values({
        domainId: input.domainId,
        stripeCheckoutSessionId: input.stripeCheckoutSessionId,
        customerEmail: input.customerEmail,
        paymentStatus: "completed",
      });

      // Generate auth code
      const authCode = `AUTH-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
      await db.insert(schema.authCodes).values({
        domainId: input.domainId,
        code: authCode,
      });

      return { success: true, authCode };
    }),
});
