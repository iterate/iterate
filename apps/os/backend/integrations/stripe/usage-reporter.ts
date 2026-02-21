import { BILLING_METERS, getMeter } from "../../billing/meters.generated.ts";
import { logger } from "../../tag-logger.ts";
import { getStripe } from "./stripe.ts";

export interface UsageReport {
  meterKey: string;
  quantity: number;
  stripeCustomerId: string;
  idempotencyKey?: string;
  timestamp?: string;
}

export async function reportUsage(report: UsageReport): Promise<void> {
  const stripe = getStripe();
  const meter = getMeter(report.meterKey);

  if (!meter) {
    throw new Error(`Unknown meter key: ${report.meterKey}`);
  }

  await stripe.v2.billing.meterEvents.create({
    event_name: meter.key,
    payload: {
      stripe_customer_id: report.stripeCustomerId,
      value: String(report.quantity),
    },
    identifier: report.idempotencyKey,
    timestamp: report.timestamp ?? new Date().toISOString(),
  });

  logger.info(`Reported usage meterKey=${report.meterKey} quantity=${report.quantity}`);
}

export async function reportLLMUsage(params: {
  stripeCustomerId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  requestId: string;
}): Promise<void> {
  const { stripeCustomerId, provider, model, inputTokens, outputTokens, requestId } = params;

  const inputMeterKey = `llm:${provider}:${model}:input`;
  const outputMeterKey = `llm:${provider}:${model}:output`;

  const inputMeter = getMeter(inputMeterKey);
  const outputMeter = getMeter(outputMeterKey);

  if (inputTokens > 0 && !inputMeter) {
    throw new Error(`No input meter found for ${provider}/${model}`);
  }

  if (outputTokens > 0 && !outputMeter) {
    throw new Error(`No output meter found for ${provider}/${model}`);
  }

  const reports: Promise<void>[] = [];

  if (inputTokens > 0 && inputMeter) {
    reports.push(
      reportUsage({
        meterKey: inputMeterKey,
        quantity: inputTokens,
        stripeCustomerId,
        idempotencyKey: `${requestId}-input`,
      }),
    );
  }

  if (outputTokens > 0 && outputMeter) {
    reports.push(
      reportUsage({
        meterKey: outputMeterKey,
        quantity: outputTokens,
        stripeCustomerId,
        idempotencyKey: `${requestId}-output`,
      }),
    );
  }

  await Promise.all(reports);
}

export async function reportSandboxUsage(params: {
  stripeCustomerId: string;
  provider: string;
  cpuSeconds: number;
  sessionId: string;
}): Promise<void> {
  const { stripeCustomerId, provider, cpuSeconds, sessionId } = params;

  const meterKey = `sandbox:${provider}`;
  const meter = getMeter(meterKey);

  if (!meter) {
    throw new Error(`No meter found for sandbox provider ${provider}`);
  }

  if (cpuSeconds > 0) {
    await reportUsage({
      meterKey,
      quantity: Math.ceil(cpuSeconds),
      stripeCustomerId,
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
