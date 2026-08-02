import { kitDeviceCapabilityPath } from "./device-id.ts";

interface KitDeviceControlProject {
  capabilityHosts: {
    get(path: string): {
      invokeCapability(call: { args: unknown[]; path: string[] }): Promise<unknown>;
    };
  };
}

/**
 * Flushes playback already admitted to one authenticated physical device.
 *
 * The PCM socket deliberately carries no control messages. Keeping this on
 * the retained Cap'n Web capability session preserves that two-lane contract,
 * while requiring literal `true` turns RPC completion into a hardware-owner
 * acknowledgement. A missing mount or rejected reset must keep the userspace
 * playout fence closed; treating either as success could splice an old Grok
 * response into speech synthesized after a server-VAD interruption.
 */
export async function interruptKitDevicePlayback(
  project: KitDeviceControlProject,
  deviceId: string,
): Promise<void> {
  const acknowledged = await project.capabilityHosts.get("/").invokeCapability({
    args: [],
    path: kitDeviceCapabilityPath(deviceId, "conversation", "interruptPlayback"),
  });
  if (acknowledged !== true) {
    throw new Error(`The ${deviceId} device did not acknowledge the playback interruption.`);
  }
}
