import type { Project } from "iterate/sdk/itx/react";
import { z } from "zod";
import { notificationOpenedEvent } from "./notification-routing.ts";

const Notification = z.object({
  offset: z.number(),
  // Device streams contain both direct requests and forwarded project notification intents.
  type: z.enum([
    "events.iterate.com/device/notification-requested",
    "events.iterate.com/notification/requested",
  ]),
  payload: z.object({
    destination: z.object({ kind: z.string(), capability: z.string().optional() }),
    expiresAt: z.number(),
  }),
});

/** Record the tap immediately; publish readiness only after live registration succeeds. */
export async function acknowledgeDeviceNotification(input: {
  project: Pick<Project, "devices" | "streams">;
  connect: () => Promise<Pick<Project, "devices">>;
  deviceId: string;
  requestOffset: number;
  notificationDate: number;
}): Promise<"opened" | "expired" | "capability-ready"> {
  const { project, deviceId, requestOffset, notificationDate } = input;
  await project.devices
    .get(deviceId)
    .append(notificationOpenedEvent(requestOffset, notificationDate));
  // Read the durable request: stale push data must not turn an unrelated or
  // expired notification into permission to wake a waiting fetch.
  const [event] = await project.streams.get(`/devices/${deviceId}`).getEvents({
    afterOffset: requestOffset - 1,
    limit: 1,
  });
  const request = Notification.parse(event);
  if (request.offset !== requestOffset) throw new Error("Notification request is missing.");
  const { destination, expiresAt } = request.payload;
  if (destination.kind !== "client-capability" || destination.capability !== "fetch")
    return "opened";
  if (expiresAt <= Date.now()) return "expired";
  const connected = await input.connect();
  if (expiresAt <= Date.now()) return "expired";
  await connected.devices.get(deviceId).append({
    type: "events.iterate.com/device/capability-ready",
    idempotencyKey: `device-capability-ready:${requestOffset}:fetch`,
    payload: { requestOffset, capability: "fetch", clientPath: `/clients/mobile/${deviceId}` },
  });
  return "capability-ready";
}
