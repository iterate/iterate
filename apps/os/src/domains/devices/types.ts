import type { ConsumedInput } from "iterate/processors";
import type { DeviceProcessorContract } from "./device-processor-contract.ts";

/** Authenticated mobile enrollment metadata plus the write-only Expo push credential. */
export type DeviceEnrollInput = {
  appVersion: string;
  expoPushToken: string;
  label: string;
  notificationsStatus: "granted";
  platform: "ios" | "android";
};

/** Safe, discoverable metadata for one project-enrolled mobile installation. */
export type DeviceDescription = {
  appVersion: string | null;
  created: boolean;
  deviceId: string;
  label: string | null;
  lastNotificationOpenedAt: string | null;
  notificationsStatus: "granted" | "revoked" | null;
  ownerId: string | null;
  platform: "ios" | "android" | null;
  revokedAt: string | null;
};

type PublicDeviceEventType =
  | "events.iterate.com/device/notification-requested"
  | "events.iterate.com/device/notification-opened";

/** Public journal vocabulary, mechanically retaining payloads from the processor contract. */
export type DeviceAppendInput = Extract<
  ConsumedInput<DeviceProcessorContract>,
  { type: PublicDeviceEventType }
>;

export const PUBLIC_DEVICE_EVENT_TYPES = new Set<PublicDeviceEventType>([
  "events.iterate.com/device/notification-requested",
  "events.iterate.com/device/notification-opened",
]);
