import type { JSONObject } from "@iterate-com/events-contract";
import { parse as parseYaml } from "yaml";

type StreamComposerDataFormat = "json" | "yaml";

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
    return parseYamlComposerValue(value);
  }

  try {
    return JSON.parse(value) as unknown;
  } catch (jsonError) {
    try {
      return parseYamlComposerValue(value);
    } catch {
      throw jsonError;
    }
  }
}

function parseYamlComposerValue(value: string): unknown {
  try {
    return parseYaml(value);
  } catch (error) {
    throw createYamlComposerError(error);
  }
}

function createYamlComposerError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "Invalid YAML.";

  return new Error(
    `${message} If you meant a string value that contains ':' (for example a curl command, URL, or inline JSON), wrap it in quotes or use a block scalar (|).`,
  );
}
