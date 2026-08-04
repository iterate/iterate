import { z } from "zod";
import type { ProviderFunctionCall } from "./pcm-proxy.ts";
import { kitDeviceCapabilityPath } from "./device-id.ts";
import { KIT_SPRITE_SETS, type KitSpriteSet } from "./sprite-sets.ts";

const emptyArgumentsSchema = z.strictObject({});
const spriteSetArgumentsSchema = z.strictObject({
  spriteSet: z.enum(KIT_SPRITE_SETS),
});

export type KitDeviceToolResult =
  | { ok: true; action: "conversation-ended" }
  | { ok: true; action: "nodded" | "shook-head" }
  | { ok: true; spriteSet: KitSpriteSet };

interface DeviceToolExecutionOptions {
  delay?: (milliseconds: number) => Promise<void>;
}

interface DeviceToolProject {
  capabilityHosts: {
    get(path: string): {
      invokeCapability(call: { args: unknown[]; path: string[] }): Promise<unknown>;
    };
  };
}

/**
 * Executes the deliberately tiny tool authority offered to Grok.
 *
 * Model arguments end at closed schemas. The project root, authenticated
 * device slug, capability members, and servo trajectories all remain worker
 * policy, so generated JSON cannot become arbitrary ITX dispatch or an unsafe
 * mechanical coordinate. Every physical step also requires the C endpoint's
 * literal `true` acknowledgement before the next step is sent.
 */
export async function executeKitDeviceTool(
  project: DeviceToolProject,
  call: ProviderFunctionCall,
  deviceId: string,
  options: DeviceToolExecutionOptions = {},
): Promise<KitDeviceToolResult> {
  switch (call.name) {
    case "changeSpriteSet": {
      const { spriteSet } = parseArguments(call.name, call.arguments, spriteSetArgumentsSchema);
      await invokeAcknowledged(project, deviceId, ["changeSpriteSet"], [spriteSet]);
      return { ok: true, spriteSet };
    }
    case "endConversation": {
      parseArguments(call.name, call.arguments, emptyArgumentsSchema);
      await invokeAcknowledged(project, deviceId, ["conversation", "hangUp"], []);
      return { ok: true, action: "conversation-ended" };
    }
    case "nod": {
      requireStackChanGesture(deviceId, call.name);
      parseArguments(call.name, call.arguments, emptyArgumentsSchema);
      await performGesture(
        project,
        deviceId,
        [
          { pitchDegrees: 25, speed: 220, yawDegrees: 0 },
          { pitchDegrees: 0, speed: 220, yawDegrees: 0 },
        ],
        options.delay,
      );
      return { ok: true, action: "nodded" };
    }
    case "shakeHead": {
      requireStackChanGesture(deviceId, call.name);
      parseArguments(call.name, call.arguments, emptyArgumentsSchema);
      await performGesture(
        project,
        deviceId,
        [
          { pitchDegrees: 0, speed: 220, yawDegrees: -25 },
          { pitchDegrees: 0, speed: 220, yawDegrees: 25 },
          { pitchDegrees: 0, speed: 220, yawDegrees: 0 },
        ],
        options.delay,
      );
      return { ok: true, action: "shook-head" };
    }
    default:
      throw new Error(`Unsupported device tool: ${call.name.slice(0, 128)}`);
  }
}

export async function executeM5StickS3Tool(
  project: DeviceToolProject,
  call: ProviderFunctionCall,
): Promise<KitDeviceToolResult> {
  return await executeKitDeviceTool(project, call, "m5sticks3");
}

function parseArguments<T>(toolName: string, serialized: string, schema: z.ZodType<T>): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    throw new Error(`${toolName} arguments must be valid JSON.`);
  }
  const result = schema.safeParse(decoded);
  if (!result.success) {
    throw new Error(`${toolName} arguments do not match its closed schema.`);
  }
  return result.data;
}

async function invokeAcknowledged(
  project: DeviceToolProject,
  deviceId: string,
  members: string[],
  args: unknown[],
): Promise<void> {
  const acknowledged = await project.capabilityHosts.get("/").invokeCapability({
    args,
    path: kitDeviceCapabilityPath(deviceId, ...members),
  });
  if (acknowledged !== true) {
    throw new Error(`The ${deviceId} device did not acknowledge ${members.join(".")}.`);
  }
}

function requireStackChanGesture(deviceId: string, toolName: string): void {
  if (deviceId !== "stackchan") {
    throw new Error(`${toolName} is only available on StackChan.`);
  }
}

async function performGesture(
  project: DeviceToolProject,
  deviceId: string,
  poses: Array<{ pitchDegrees: number; speed: number; yawDegrees: number }>,
  injectedDelay?: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const delay =
    injectedDelay ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (const [index, pose] of poses.entries()) {
    await invokeAcknowledged(project, deviceId, ["servos", "move"], [pose]);
    /*
     * The SCS0009 executes each timed move independently after the UART packet
     * is copied. Waiting here sequences a recognizable gesture in userspace;
     * it never blocks the firmware control task or either realtime audio owner.
     * The final neutral pose needs no trailing delay before tool completion.
     */
    if (index + 1 < poses.length) await delay(pose.speed + 30);
  }
}
