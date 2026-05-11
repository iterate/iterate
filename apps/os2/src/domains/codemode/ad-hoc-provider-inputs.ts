import { parse as parseYaml } from "yaml";
import type { CodemodeProviderInput } from "~/domains/codemode/examples.ts";

export const emptyHeadersYaml = "{}\n";
export const defaultCodemodeCode = 'async (ctx) => {\n  console.log("hello");\n  return 1 + 1;\n}';

export type CodemodeAdHocProviderFieldsValue = {
  mcpHeadersYaml: string;
  mcpPath: string;
  mcpServerUrl: string;
  openApiBaseUrl: string;
  openApiHeadersYaml: string;
  openApiPath: string;
  openApiSpecUrl: string;
};

export function createEmptyAdHocProviderFields(): CodemodeAdHocProviderFieldsValue {
  return {
    mcpHeadersYaml: emptyHeadersYaml,
    mcpPath: "mcp.custom",
    mcpServerUrl: "",
    openApiBaseUrl: "",
    openApiHeadersYaml: emptyHeadersYaml,
    openApiPath: "api.custom",
    openApiSpecUrl: "",
  };
}

export function hasAdHocProviderFields(value: CodemodeAdHocProviderFieldsValue) {
  return (
    value.mcpServerUrl.trim() !== "" ||
    value.openApiSpecUrl.trim() !== "" ||
    value.openApiBaseUrl.trim() !== ""
  );
}

export function buildAdHocProviderInputs(
  input: CodemodeAdHocProviderFieldsValue,
): CodemodeProviderInput[] {
  const providers: CodemodeProviderInput[] = [];
  const trimmedMcpUrl = input.mcpServerUrl.trim();
  if (trimmedMcpUrl !== "") {
    providers.push({
      type: "outbound-mcp",
      path: parseContextPath(input.mcpPath),
      serverUrl: trimmedMcpUrl,
      headers: parseHeaders(input.mcpHeadersYaml),
    });
  }

  const trimmedSpecUrl = input.openApiSpecUrl.trim();
  const trimmedBaseUrl = input.openApiBaseUrl.trim();
  if (trimmedSpecUrl !== "" || trimmedBaseUrl !== "") {
    if (trimmedSpecUrl === "" || trimmedBaseUrl === "") {
      throw new Error("OpenAPI providers require both a spec URL and a base URL.");
    }
    providers.push({
      type: "openapi",
      path: parseContextPath(input.openApiPath),
      specUrl: trimmedSpecUrl,
      baseUrl: trimmedBaseUrl,
      headers: parseHeaders(input.openApiHeadersYaml),
    });
  }

  return providers;
}

function parseHeaders(value: string) {
  const parsed = parseYaml(value.trim() || "{}") as unknown;
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers must be a YAML object.");
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, headerValue]) => {
      if (typeof headerValue !== "string") {
        throw new Error(`Header ${key} must be a string.`);
      }
      return [key, headerValue];
    }),
  );
}

function parseContextPath(value: string) {
  const path = value
    .trim()
    .replace(/^ctx\./, "")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (path.length === 0) {
    throw new Error("Provider context path is required.");
  }

  return path;
}
