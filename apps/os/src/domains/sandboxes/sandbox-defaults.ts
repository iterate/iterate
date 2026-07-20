import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import type { SandboxInstanceType } from "./instance-types.ts";
import { SandboxProcessorContract } from "./sandbox-processor-contract.ts";

/** The complete atomic sandbox birth batch: certificate plus hosted processor subscription. */
export function sandboxCreationEvents(input: {
  env?: Record<string, string | undefined>;
  instanceType: SandboxInstanceType;
  path: string;
  projectId: string;
}) {
  const { instanceType, path, projectId } = input;
  const durableObjectName = DurableObjectNameCodec.stringify({ path, projectId });
  return [
    SandboxProcessorContract.buildEvent({
      type: "events.iterate.com/sandbox/created",
      idempotencyKey: `sandbox/created:${projectId}:${path}`,
      payload: { config: { instanceType } },
    }),
    ...(input.env === undefined || Object.keys(input.env).length === 0
      ? []
      : [
          SandboxProcessorContract.buildEvent({
            type: "events.iterate.com/sandbox/configured",
            idempotencyKey: `sandbox/configured-at-creation:${projectId}:${path}`,
            payload: {
              env: Object.fromEntries(
                Object.entries(input.env).map(([key, value]) => [key, value ?? null]),
              ),
            },
          }),
        ]),
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${SandboxProcessorContract.slug}`,
      processor: ["sandboxes", ["get", path], "processor"],
      processorSlug: SandboxProcessorContract.slug,
    }),
  ];
}
