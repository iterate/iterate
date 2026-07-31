import type { ProviderFunctionCall } from "./pcm-proxy.ts";

type DeviceColour = "green" | "red";

const devicePath = ["kit", "m5sticks3"] as const;

/**
 * Executes the deliberately tiny tool authority offered to Grok.
 *
 * The model supplies only a closed `{colour}` value. The project root, device
 * path, and method are worker-owned constants, so neither prompt injection nor
 * malformed generated JSON can turn this convenience tool into arbitrary ITX
 * dispatch. A resolved RPC is not sufficient: the C capability must return the
 * literal acknowledgement `true` before Grok is told the physical screen
 * changed.
 */
export async function executeM5StickS3Tool(
  project: DeviceToolProject,
  call: ProviderFunctionCall,
): Promise<{ colour: DeviceColour; ok: true }> {
  if (call.name !== "changeColour") {
    throw new Error(`Unsupported device tool: ${call.name.slice(0, 128)}`);
  }
  const colour = parseColourArguments(call.arguments);
  const acknowledged = await project.capabilityHosts.get("/").invokeCapability({
    args: [colour],
    path: [...devicePath, "changeColour"],
  });
  if (acknowledged !== true) {
    throw new Error("The M5StickS3 did not acknowledge the display colour change.");
  }
  return { colour, ok: true };
}

interface DeviceToolProject {
  capabilityHosts: {
    get(path: string): {
      invokeCapability(call: { args: unknown[]; path: string[] }): Promise<unknown>;
    };
  };
}

function parseColourArguments(serialized: string): DeviceColour {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("changeColour arguments must be valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("changeColour expects exactly {colour: red | green}.");
  }
  const keys = Object.keys(value);
  const colour = "colour" in value ? value.colour : undefined;
  if (keys.length !== 1 || keys[0] !== "colour" || (colour !== "red" && colour !== "green")) {
    throw new Error("changeColour expects exactly {colour: red | green}.");
  }
  return colour;
}
