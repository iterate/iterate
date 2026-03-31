import type { JSONObject } from "@iterate-com/events-contract";

/** Round-trip through JSON so values match `JSONObject` (events app payloads). */
export function toJSONObject(value: unknown): JSONObject {
  return JSON.parse(JSON.stringify(value)) as JSONObject;
}
