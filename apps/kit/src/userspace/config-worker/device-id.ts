const kitDeviceIdPattern = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * A device identity is a single conservative slug shared by the PCM
 * authentication header and durable evidence stream. It begins with a letter
 * so its derived ITX member below can never violate the capability host's
 * JavaScript-identifier grammar.
 */
export function isKitDeviceId(value: string): boolean {
  return kitDeviceIdPattern.test(value);
}

/**
 * Returns the capability-path member corresponding to one authenticated
 * device slug.
 *
 * URLs, headers, and stream paths need stable kebab-case identity; Cap'n Web
 * dotted dispatch needs a JavaScript member name. Conflating them made HAVPE's
 * production mount (`home-assistant-voice-preview-edition`) authenticate and
 * then fail at provide time. Camel-casing is deterministic and allocation is
 * irrelevant here: this runs in userspace only at sparse control boundaries,
 * never in the device's PCM loop.
 */
export function kitDeviceCapabilitySegment(deviceId: string): string {
  if (!isKitDeviceId(deviceId)) {
    throw new Error(`Invalid Iterate Kit device id: ${deviceId.slice(0, 64)}`);
  }

  let capabilitySegment = "";
  let capitalizeNext = false;
  for (const character of deviceId) {
    if (character === "-") {
      capitalizeNext = true;
      continue;
    }
    capabilitySegment += capitalizeNext ? character.toUpperCase() : character;
    capitalizeNext = false;
  }
  return capabilitySegment;
}

/**
 * Constructs every worker-to-device ITX call from the authenticated slug.
 * Centralizing the namespace translation keeps event, metrics, interruption,
 * and provider-tool calls on one physical capability even when a device name
 * contains hyphens.
 */
export function kitDeviceCapabilityPath(deviceId: string, ...members: string[]): string[] {
  return ["kit", kitDeviceCapabilitySegment(deviceId), ...members];
}
