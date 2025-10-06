import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { typeid } from "typeid-js";

function prefixID(type: string): () => string {
  return () => typeid(type).toString();
}

export const domains = sqliteTable("domains", {
  id: text("id").primaryKey().$defaultFn(prefixID("domain")),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  purchased: integer("purchased", { mode: "boolean" }).notNull().default(false),
  purchasedAt: integer("purchased_at", { mode: "timestamp" }),
  nameWithTld: text("name_with_tld").notNull(),
  amountInMinorUnits: integer("amount_in_minor_units").notNull(),
  currency: text("currency").notNull().default("USD"),
  tier: text("tier").notNull(), // "1", "2", or "3"
});

export const purchases = sqliteTable("purchases", {
  id: text("id").primaryKey().$defaultFn(prefixID("purchase")),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  domainId: text("domain_id")
    .notNull()
    .references(() => domains.id),
  stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull(),
  customerEmail: text("customer_email").notNull(),
  paymentStatus: text("payment_status").notNull(),
});

export const authCodes = sqliteTable("auth_codes", {
  id: text("id").primaryKey().$defaultFn(prefixID("auth_code")),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  domainId: text("domain_id")
    .notNull()
    .references(() => domains.id),
  code: text("code").notNull(),
});
