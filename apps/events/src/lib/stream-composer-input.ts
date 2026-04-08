import type { JSONObject } from "@iterate-com/events-contract";
import { parse as parseYaml } from "yaml";

export type StreamComposerDataFormat = "json" | "yaml";

export function parseObjectFromComposerText(
  value: string,
  format: StreamComposerDataFormat,
): JSONObject {
  const parsed = parseComposerValue(value, format);

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Value must be a ${format === "yaml" ? "YAML" : "JSON"} object.`);
  }

  return parsed as JSONObject;
}

function parseComposerValue(value: string, format: StreamComposerDataFormat): unknown {
  if (format === "yaml") {
    return parseYaml(value);
  }

  try {
    return JSON.parse(value) as unknown;
  } catch (jsonError) {
    try {
      return parseYaml(value);
    } catch {
      throw jsonError;
    }
  }
}
