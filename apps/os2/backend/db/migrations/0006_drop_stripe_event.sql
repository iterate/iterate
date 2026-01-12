DROP TABLE "stripe_event";--> statement-breakpoint
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_stripeSubscriptionId_unique" UNIQUE("stripe_subscription_id");
