export type MeterCategory = "llm" | "sandbox" | "storage" | "bandwidth";

export type MeterUnit = "tokens" | "seconds" | "bytes" | "requests";

export type MeterDirection = "input" | "output" | "both";

export interface BillingMeter {
  key: string;
  displayName: string;
  category: MeterCategory;
  provider: string;
  model?: string;
  unit: MeterUnit;
  direction?: MeterDirection;
  costPerUnit: number;
  stripePriceId?: string;
  stripeProductId?: string;
  aggregateKey: string;
}

export interface BillingMetersConfig {
  version: string;
  generatedAt: string;
  meters: Record<string, BillingMeter>;
}

export function getMeterKey(
  category: MeterCategory,
  provider: string,
  model: string | undefined,
  direction: MeterDirection | undefined,
): string {
  const parts = [category, provider];
  if (model) parts.push(model);
  if (direction && direction !== "both") parts.push(direction);
  return parts.join(":");
}

export function getAggregateKey(
  category: MeterCategory,
  provider: string,
  direction?: MeterDirection,
): string {
  const parts = [category, provider];
  if (direction && direction !== "both") parts.push(direction);
  return parts.join(":");
}
