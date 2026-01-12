import { BILLING_METERS, getMeter } from "../../billing/meters.generated.ts";
import { logger } from "../../tag-logger.ts";
import { getStripe } from "./stripe.ts";

export interface UsageReport {
  meterKey: string;
  quantity: number;
  subscriptionItemId: string;
  idempotencyKey: string;
  timestamp?: number;
}

export async function reportUsage(report: UsageReport): Promise<void> {
  const stripe = getStripe();
  const meter = getMeter(report.meterKey);

  if (!meter) {
    logger.error(`Unknown meter key: ${report.meterKey}`);
    return;
  }

  if (!meter.stripePriceId) {
    logger.error(`Meter ${report.meterKey} has no Stripe price ID - run billing:sync first`);
    return;
  }

  try {
    await (stripe.subscriptionItems as any).createUsageRecord(
      report.subscriptionItemId,
      {
        quantity: report.quantity,
        timestamp: report.timestamp ?? Math.floor(Date.now() / 1000),
        action: "increment",
      },
      { idempotencyKey: report.idempotencyKey },
    );
  } catch (error) {
    logger.error(`Failed to report usage for ${report.meterKey}`, error);
    throw error;
  }
}

export async function reportLLMUsage(params: {
  subscriptionItemId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  requestId: string;
}): Promise<void> {
  const { subscriptionItemId, provider, model, inputTokens, outputTokens, requestId } = params;

  const inputMeterKey = `llm:${provider}:${model}:input`;
  const outputMeterKey = `llm:${provider}:${model}:output`;

  const inputMeter = getMeter(inputMeterKey);
  const outputMeter = getMeter(outputMeterKey);

  if (!inputMeter || !outputMeter) {
    logger.info(`No meters found for ${provider}/${model}, using aggregate meters`);
    return;
  }

  if (inputTokens > 0) {
    await reportUsage({
      meterKey: inputMeterKey,
      quantity: inputTokens,
      subscriptionItemId,
      idempotencyKey: `${requestId}-input`,
    });
  }

  if (outputTokens > 0) {
    await reportUsage({
      meterKey: outputMeterKey,
      quantity: outputTokens,
      subscriptionItemId,
      idempotencyKey: `${requestId}-output`,
    });
  }
}

export async function reportSandboxUsage(params: {
  subscriptionItemId: string;
  provider: string;
  cpuSeconds: number;
  sessionId: string;
}): Promise<void> {
  const { subscriptionItemId, provider, cpuSeconds, sessionId } = params;

  const meterKey = `sandbox:${provider}`;
  const meter = getMeter(meterKey);

  if (!meter) {
    logger.info(`No meter found for sandbox provider ${provider}`);
    return;
  }

  if (cpuSeconds > 0) {
    await reportUsage({
      meterKey,
      quantity: Math.ceil(cpuSeconds),
      subscriptionItemId,
      idempotencyKey: `sandbox-${sessionId}`,
    });
  }
}

export function calculateUsageCost(meterKey: string, quantity: number): number {
  const meter = getMeter(meterKey);
  if (!meter) return 0;
  return meter.costPerUnit * quantity;
}

export function getAvailableMeters() {
  return Object.values(BILLING_METERS);
}
