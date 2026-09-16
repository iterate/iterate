import { createFileRoute, redirect } from "@tanstack/react-router";
import { DEFAULT_DEVICE_ID, DEFAULT_FIRMWARE_VERSION } from "../firmware/catalog.ts";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({
      to: "/devices/$deviceId/firmware/$firmwareVersion",
      params: {
        deviceId: DEFAULT_DEVICE_ID,
        firmwareVersion: DEFAULT_FIRMWARE_VERSION,
      },
    });
  },
});
