#!/usr/bin/env tsx
/* eslint-disable no-console -- CLI script uses console for user output */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import type { BillingMeter, BillingMetersConfig } from "../types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const billingDir = join(__dirname, "..");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY environment variable is required");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

async function getOrCreateProduct(meter: BillingMeter): Promise<string> {
  const productName = `Usage: ${meter.displayName}`;
  const metadata = {
    meterKey: meter.key,
    category: meter.category,
    provider: meter.provider,
    model: meter.model || "",
    unit: meter.unit,
    direction: meter.direction || "",
    aggregateKey: meter.aggregateKey,
  };

  if (meter.stripeProductId) {
    try {
      const existing = await stripe.products.retrieve(meter.stripeProductId);
      if (existing && !existing.deleted) {
        console.log(`  Product exists: ${meter.stripeProductId}`);
        return meter.stripeProductId;
      }
    } catch {
      console.log(`  Product ${meter.stripeProductId} not found, creating new...`);
    }
  }

  const existingProducts = await stripe.products.search({
    query: `metadata["meterKey"]:"${meter.key}"`,
  });

  if (existingProducts.data.length > 0) {
    const productId = existingProducts.data[0].id;
    console.log(`  Found existing product by metadata: ${productId}`);
    return productId;
  }

  const product = await stripe.products.create({
    name: productName,
    description: `Metered billing for ${meter.category}/${meter.provider}${meter.model ? `/${meter.model}` : ""}`,
    metadata,
  });

  console.log(`  Created product: ${product.id}`);
  return product.id;
}

async function getOrCreatePrice(meter: BillingMeter, productId: string): Promise<string> {
  const unitAmountDecimal = (meter.costPerUnit * 100).toFixed(10);

  if (meter.stripePriceId) {
    try {
      const existing = await stripe.prices.retrieve(meter.stripePriceId);
      if (existing && existing.active) {
        console.log(`  Price exists: ${meter.stripePriceId}`);
        return meter.stripePriceId;
      }
    } catch {
      console.log(`  Price ${meter.stripePriceId} not found, creating new...`);
    }
  }

  const existingPrices = await stripe.prices.list({
    product: productId,
    active: true,
    limit: 100,
  });

  for (const price of existingPrices.data) {
    if (price.recurring?.usage_type === "metered" && price.billing_scheme === "per_unit") {
      console.log(`  Found existing metered price: ${price.id}`);
      return price.id;
    }
  }

  const price = await stripe.prices.create({
    product: productId,
    currency: "usd",
    unit_amount_decimal: unitAmountDecimal,
    recurring: {
      interval: "month",
      usage_type: "metered",
    },
    billing_scheme: "per_unit",
    metadata: {
      meterKey: meter.key,
      costPerUnit: meter.costPerUnit.toString(),
    },
  });

  console.log(`  Created metered price: ${price.id} ($${meter.costPerUnit}/unit)`);
  return price.id;
}

function loadMetersConfig(): BillingMetersConfig {
  const configPath = join(billingDir, "meters.generated.ts");
  const content = readFileSync(configPath, "utf-8");

  const configMatch = content.match(
    /export const BILLING_METERS_CONFIG: BillingMetersConfig = ({[\s\S]*?});/,
  );
  if (!configMatch) {
    throw new Error("Could not parse meters.generated.ts");
  }

  const configStr = configMatch[1]
    .replace(/satisfies BillingMeter,/g, ",")
    .replace(/,(\s*[}\]])/g, "$1");

  return eval(`(${configStr})`) as BillingMetersConfig;
}

function updateMetersFile(meters: Record<string, BillingMeter>): void {
  const configPath = join(billingDir, "meters.generated.ts");
  let content = readFileSync(configPath, "utf-8");

  for (const [key, meter] of Object.entries(meters)) {
    if (meter.stripePriceId) {
      const pricePattern = new RegExp(
        `("${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}": \\{[^}]*)(\\n\\s*aggregateKey:)`,
        "s",
      );
      if (!content.includes(`stripePriceId: "${meter.stripePriceId}"`)) {
        content = content.replace(
          pricePattern,
          `$1\n      stripePriceId: "${meter.stripePriceId}",\n      stripeProductId: "${meter.stripeProductId}",$2`,
        );
      }
    }
  }

  writeFileSync(configPath, content);
  console.log(`\nUpdated ${configPath} with Stripe IDs`);
}

async function syncMetersToStripe(): Promise<void> {
  console.log("Syncing billing meters to Stripe...\n");

  const config = loadMetersConfig();
  const meters = { ...config.meters };
  const meterKeys = Object.keys(meters).sort();

  console.log(`Found ${meterKeys.length} meters to sync\n`);

  let created = 0;
  let existing = 0;
  let errors = 0;

  for (const key of meterKeys) {
    const meter = meters[key];
    console.log(`Processing: ${key}`);

    try {
      const productId = await getOrCreateProduct(meter);
      const priceId = await getOrCreatePrice(meter, productId);

      meter.stripeProductId = productId;
      meter.stripePriceId = priceId;

      if (!config.meters[key].stripePriceId) {
        created++;
      } else {
        existing++;
      }
    } catch (error) {
      console.error(`  Error: ${error}`);
      errors++;
    }

    console.log("");
  }

  updateMetersFile(meters);

  console.log("\n=== Sync Summary ===");
  console.log(`  Created: ${created}`);
  console.log(`  Existing: ${existing}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Total: ${meterKeys.length}`);
}

syncMetersToStripe().catch(console.error);
