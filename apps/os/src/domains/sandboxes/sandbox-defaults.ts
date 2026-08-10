import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import type { SubscriptionConfiguredPayload } from "../streams/core-processor-contract.ts";
import { DEFAULT_SANDBOX_INSTANCE_TYPE, SandboxInstanceType } from "./instance-types.ts";
import { SandboxProcessorContract } from "./sandbox-processor-contract.ts";
import { assertValidSleepAfter, sandboxCreateClaimKey, type SandboxCreateInput } from "./utils.ts";

/** The canonical `/sandboxes` catalogue claim for one create request. */
export function sandboxCreateClaimEvent(input: { create: SandboxCreateInput; path: string }) {
  const instanceType = SandboxInstanceType.parse(
    input.create.instanceType ?? DEFAULT_SANDBOX_INSTANCE_TYPE,
  );
  if (input.create.sleepAfter !== undefined) assertValidSleepAfter(input.create.sleepAfter);
  return SandboxProcessorContract.buildEvent({
    type: "events.iterate.com/sandbox/create-requested",
    idempotencyKey: sandboxCreateClaimKey(input.path),
    payload: {
      path: input.path,
      instanceType,
      ...(input.create.sleepAfter === undefined ? {} : { sleepAfter: input.create.sleepAfter }),
      ...(input.create.keepAlive === undefined ? {} : { keepAlive: input.create.keepAlive }),
      ...(input.create.env === undefined ? {} : { env: input.create.env }),
    },
  });
}

/** The complete atomic sandbox birth batch: certificate plus hosted processor subscription. */
export function sandboxCreationEvents(input: {
  env?: Record<string, string | undefined>;
  instanceType: SandboxInstanceType;
  path: string;
  projectId: string;
}) {
  const { instanceType, path, projectId } = input;
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
    // The sandbox processor deliberately STAYS hosted in its own Durable
    // Object (the Containers SDK owns that DO's class), so its wake keeps the
    // itx expression instead of facet placement.
    CoreProcessorContract.buildEvent({
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: `stream/subscription-configured:${SandboxProcessorContract.slug}`,
      payload: {
        name: SandboxProcessorContract.slug,
        receiver: {
          action: "wake-processor",
          expression: ["sandboxes", ["get", path], "processor", "wakeStreamProcessor"],
        },
      } satisfies SubscriptionConfiguredPayload,
    }),
  ];
}
