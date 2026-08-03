import type { z } from "zod";
import { buildFacetProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { DeviceProcessorContract } from "./device-processor-contract.ts";

/** The immutable `device/created` enrollment birth certificate payload. */
export type DeviceCreatePayload = z.input<
  (typeof DeviceProcessorContract.events)["events.iterate.com/device/created"]["payloadSchema"]
>;

/** The complete atomic device birth batch: certificate plus processor subscription. */
export function deviceCreationEvents(input: {
  deviceId: string;
  payload: DeviceCreatePayload;
  projectId: string;
}) {
  const { deviceId, payload, projectId } = input;
  return [
    DeviceProcessorContract.buildEvent({
      type: "events.iterate.com/device/created",
      idempotencyKey: `device/created:${projectId}:${deviceId}`,
      payload,
    }),
    buildFacetProcessorSubscriptionConfiguredEvent({
      idempotencyKey: `stream/subscription-configured:${DeviceProcessorContract.slug}`,
      processorSlug: DeviceProcessorContract.slug,
    }),
  ];
}
