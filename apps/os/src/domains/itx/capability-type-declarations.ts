// Connect-time auto-typing: turn what a connection door already knows about
// its service — MCP tool inputSchemas, OpenAPI operations — into a Capability
// Type Declaration (a TypeScript `types` string, the same metadata a
// provideCapability author can write by hand). The conversion is a navigation
// aid, deliberately lossy: JSON Schema constraints that TypeScript cannot
// express (maxLength, patterns) are dropped, and anything unrecognized
// becomes `unknown`. Runtime validation stays with the service.
import type { Tool } from "@modelcontextprotocol/client";
import { resolveJsonSchema, type JsonSchema } from "./json-schema-types.ts";
import type { OpenApiOperation } from "./openapi-types.ts";
import { operationBodySchema, isObjectSchema } from "./openapi-types.ts";
import { stripComments } from "./itx-api-graph.ts";

/** How deep nested schemas render before collapsing to `unknown` — beyond
 * this, a docs reader is better served by brevity than fidelity. */
const MAX_SCHEMA_DEPTH = 4;

/**
 * Render a JSON Schema as TypeScript type text. `root` anchors `$ref`
 * resolution; without one, `$ref`s render as `unknown`.
 */
export function jsonSchemaToTypeText(schema: unknown, root?: JsonSchema, depth = 0): string {
  const resolved = resolveJsonSchema(schema, root ?? {});
  if (resolved === undefined || resolved === true) return "unknown";
  if (resolved === false) return "never";
  if (depth >= MAX_SCHEMA_DEPTH) return "unknown";

  const node = resolved;
  if (Array.isArray(node.enum)) {
    return node.enum.map((value) => JSON.stringify(value)).join(" | ") || "never";
  }
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants)) {
    const rendered = variants.map((variant) => jsonSchemaToTypeText(variant, root, depth + 1));
    return [...new Set(rendered)].join(" | ") || "unknown";
  }
  if (Array.isArray(node.allOf)) {
    const rendered = node.allOf.map((part) => jsonSchemaToTypeText(part, root, depth + 1));
    return [...new Set(rendered)].join(" & ") || "unknown";
  }
  if (Array.isArray(node.type)) {
    return node.type
      .map((t) => jsonSchemaToTypeText({ ...node, type: t }, root, depth))
      .join(" | ");
  }

  switch (node.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${jsonSchemaToTypeText(node.items, root, depth + 1)}>`;
    case "object":
    case undefined: {
      const properties = node.properties as Record<string, unknown> | undefined;
      if (!properties) return node.type === "object" ? "Record<string, unknown>" : "unknown";
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      const members = Object.entries(properties).map(([name, property]) => {
        const resolvedProperty = resolveJsonSchema(property, root ?? {});
        const description =
          resolvedProperty !== undefined &&
          typeof resolvedProperty === "object" &&
          typeof resolvedProperty.description === "string"
            ? `/** ${escapeCommentText(resolvedProperty.description)} */ `
            : "";
        const optional = required.has(name) ? "" : "?";
        return `${description}${quoteMemberName(name)}${optional}: ${jsonSchemaToTypeText(property, root, depth + 1)}`;
      });
      return `{ ${members.join("; ")} }`;
    }
    default:
      return "unknown";
  }
}

/**
 * The generated Capability Type Declaration for a connected MCP server: one
 * method per tool, input typed from the tool's inputSchema. The FIRST export
 * is the mount's own type (the convention every `types` string follows).
 */
export function mcpCapabilityTypeDeclaration(tools: Tool[]): string {
  const members = tools.map((tool) => {
    const doc = tool.description ? `  /** ${escapeCommentText(tool.description)} */\n` : "";
    // Depth starts at 1: the input object renders inline inside the method
    // member, pre-spending one nesting level of the depth budget.
    const input = jsonSchemaToTypeText(tool.inputSchema, tool.inputSchema as JsonSchema, 1);
    return `${doc}  ${quoteMemberName(tool.name)}(input: ${input}): Promise<unknown>;`;
  });
  return `export type Capability = {\n${members.join("\n")}\n};`;
}

/**
 * The generated Capability Type Declaration for a connected OpenAPI service:
 * one method per operationId. The input type mirrors dispatch
 * (`executeOperation`): one object carrying the operation's named parameters
 * plus the JSON request body's properties.
 */
export function openApiCapabilityTypeDeclaration(
  operations: OpenApiOperation[],
  spec: Record<string, unknown>,
): string {
  const members = operations.map((operation) => {
    const doc = operation.summary ? `  /** ${escapeCommentText(operation.summary)} */\n` : "";
    const parts: string[] = [];
    for (const parameter of operation.parameters) {
      const type = jsonSchemaToTypeText(parameter.schema, spec as JsonSchema, 1);
      const optional = parameter.required ? "" : "?";
      parts.push(`${quoteMemberName(parameter.name)}${optional}: ${type}`);
    }
    const body = operationBodySchema(operation, spec);
    if (isObjectSchema(body)) {
      const bodyType = jsonSchemaToTypeText(body, spec as JsonSchema, 1);
      // Body properties merge into the same input object by unwrapping the
      // rendered literal's braces. A body that renders as anything else
      // (say a property-less object -> Record<string, unknown>) cannot be
      // spliced into members, so it stays out and the input just loosens.
      if (bodyType.startsWith("{ ") && bodyType.endsWith(" }")) {
        parts.push(bodyType.slice(2, -2));
      }
    }
    const input =
      parts.length > 0 ? `input: { ${parts.join("; ")} }` : "input?: Record<string, unknown>";
    return `${doc}  ${quoteMemberName(operation.operationId)}(${input}): Promise<unknown>;`;
  });
  return `export type Capability = {\n${members.join("\n")}\n};`;
}

/**
 * The name a `types` string binds its mount to: the first exported
 * type/interface declaration. Later exports are supporting types. Undefined
 * when the text exports nothing recognizable — consumers then treat the
 * mount as untyped.
 */
export function firstExportedTypeName(typesText: string): string | undefined {
  return stripComments(typesText).match(
    /export\s+(?:type|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  )?.[1];
}

function quoteMemberName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function escapeCommentText(text: string): string {
  return text.replaceAll("*/", "*\\/").replaceAll(/\s+/g, " ").trim();
}
