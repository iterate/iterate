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
 * Ceiling on a GENERATED declaration that rides the journal (~8k tokens).
 * A declaration over this is noise to every reader; past it the mount keeps
 * a one-line permissive type plus the provenance pointer instead. (OpenAPI
 * mounts never hit this — they journal a spec REFERENCE the typechecker
 * materializes at check time, exactly like npm imports.)
 */
const MAX_GENERATED_DECLARATION_CHARS = 32_000;

/**
 * The reference form an OpenAPI mount journals: one line naming the spec,
 * resolved to the full generated declaration by the typechecker at check
 * time (see materializeOpenApiModules in run-typecheck.ts) — the same
 * store-a-reference mechanism as `import("@slack/web-api").WebClient`.
 * Nothing bulky ever enters the journal or an agent's context.
 */
export function openApiCapabilityTypeReference(specUrl: string): string {
  return (
    `// Generated from ${specUrl}\n` +
    `// Operation names and inputs resolve when itx.docs.typecheck compiles a script\n` +
    `// against this mount; the spec at the URL above lists them for reading.\n` +
    `export type Capability = import(${JSON.stringify(`openapi:${specUrl}`)}).Capability;`
  );
}

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
      if (!node.properties) return node.type === "object" ? "Record<string, unknown>" : "unknown";
      const members = objectSchemaMembers(node, root, depth).map((member) => member.text);
      return `{ ${members.join("; ")} }`;
    }
    default:
      return "unknown";
  }
}

/** An object schema's properties as named member texts — shared by the
 * object case above and the OpenAPI body merge (which needs the NAMES to
 * drop body properties that collide with parameter names). */
function objectSchemaMembers(
  node: Record<string, unknown>,
  root: JsonSchema | undefined,
  depth: number,
): Array<{ name: string; text: string }> {
  const properties = (node.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  return Object.entries(properties).map(([name, property]) => {
    const resolvedProperty = resolveJsonSchema(property, root ?? {});
    const description =
      resolvedProperty !== undefined &&
      typeof resolvedProperty === "object" &&
      typeof resolvedProperty.description === "string"
        ? `/** ${escapeCommentText(resolvedProperty.description)} */ `
        : "";
    const optional = required.has(name) ? "" : "?";
    return {
      name,
      text: `${description}${quoteMemberName(name)}${optional}: ${jsonSchemaToTypeText(property, root, depth + 1)}`,
    };
  });
}

/**
 * The generated Capability Type Declaration for a connected MCP server: one
 * method per tool, input typed from the tool's inputSchema. The FIRST export
 * is the mount's own type (the convention every `types` string follows).
 * `source` becomes a provenance comment pointing readers at the real thing.
 */
export function mcpCapabilityTypeDeclaration(tools: Tool[], source: string): string {
  const members = tools.map((tool) => {
    const doc = tool.description ? `  /** ${escapeCommentText(tool.description)} */\n` : "";
    // Depth starts at 1: the input object renders inline inside the method
    // member, pre-spending one nesting level of the depth budget.
    const input = jsonSchemaToTypeText(tool.inputSchema, tool.inputSchema as JsonSchema, 1);
    // Dispatch treats a missing argument as {} — the input parameter is only
    // required when the schema actually requires a property.
    const requiredProperties = (tool.inputSchema as { required?: unknown } | undefined)?.required;
    const required = Array.isArray(requiredProperties) && requiredProperties.length > 0;
    return `${doc}  ${quoteMemberName(tool.name)}(input${required ? "" : "?"}: ${input}): Promise<unknown>;`;
  });
  return withGeneratedBudget({ members, source });
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
    const parameterNames = new Set<string>();
    let requiredInput = false;
    for (const parameter of operation.parameters) {
      // OpenAPI allows one name in several locations (path + query); the
      // input object has one key, so the first declaration wins.
      if (parameterNames.has(parameter.name)) continue;
      const type = jsonSchemaToTypeText(parameter.schema, spec as JsonSchema, 1);
      if (parameter.required) requiredInput = true;
      parameterNames.add(parameter.name);
      parts.push(`${quoteMemberName(parameter.name)}${parameter.required ? "" : "?"}: ${type}`);
    }
    // The body follows dispatch's conventions (executeOperation): an object
    // body's properties merge into the input object; a NON-object body
    // (string, array, union) rides under a `body` key; an object body
    // without listed properties means leftover input keys ARE the body. A
    // body property named like a parameter is DROPPED — the parameter claims
    // that input key at dispatch, and a duplicate member would fail the
    // compile gate and silently untype the whole mount (`/user/{username}`
    // with `username` in the body is the classic REST echo).
    const body = operationBodySchema(operation, spec);
    if (isObjectSchema(body)) {
      const bodyMembers = objectSchemaMembers(body, spec as JsonSchema, 1).filter(
        (member) => !parameterNames.has(member.name),
      );
      if (Object.keys((body.properties ?? {}) as object).length > 0) {
        parts.push(...bodyMembers.map((member) => member.text));
        const requiredBody = new Set(Array.isArray(body.required) ? body.required : []);
        if (bodyMembers.some((member) => requiredBody.has(member.name))) requiredInput = true;
      } else {
        parts.push("[key: string]: unknown");
      }
    } else if (body !== undefined) {
      parts.push(`body?: ${jsonSchemaToTypeText(body, spec as JsonSchema, 1)}`);
    }
    const input =
      parts.length > 0
        ? `input${requiredInput ? "" : "?"}: { ${parts.join("; ")} }`
        : "input?: Record<string, unknown>";
    return `${doc}  ${quoteMemberName(operation.operationId)}(${input}): Promise<unknown>;`;
  });
  // No budget cap and no provenance header: this full form never rides the
  // journal — the check-time materializer consumes it in memory (see
  // run-typecheck.ts); journals carry openApiCapabilityTypeReference instead.
  return `export type Capability = {\n${members.join("\n")}\n};`;
}

/**
 * Assemble a generated declaration under the size ceiling: full schemas when
 * they fit, a one-line permissive type when they do not — a wall of member
 * names helps no reader, and the provenance line says where the real
 * definitions live.
 */
function withGeneratedBudget(input: { members: string[]; source: string }): string {
  const header = `// Generated from ${input.source}\n`;
  const full = `${header}export type Capability = {\n${input.members.join("\n")}\n};`;
  if (full.length <= MAX_GENERATED_DECLARATION_CHARS) return full;
  return (
    `${header}// Over budget: any member name is accepted — typos are NOT caught for this\n` +
    `// mount; the source above lists the real tools.\n` +
    `export type Capability = Record<string, (input?: Record<string, unknown>) => Promise<unknown>>;`
  );
}

/**
 * The name a `types` string binds its mount to: the first TOP-LEVEL exported
 * type, interface, class, or enum. Later exports are supporting types.
 * Undefined when the text exports nothing recognizable — consumers then
 * treat the mount as untyped, and provide-time validation rejects it
 * (a `types` string without a mount type is an authoring mistake).
 *
 * Top-level matters: `export interface Inner` nested inside an
 * `export namespace NS { … }` is not importable by bare name — picking it
 * produced an unresolvable type reference that broke typechecking for the
 * WHOLE scope. Brace depth is counted on comment-stripped text (a lone
 * unbalanced brace inside a string literal type can fool it; template-literal
 * placeholders are balanced and cannot).
 */
export function firstExportedTypeName(typesText: string): string | undefined {
  const codeOnly = stripComments(typesText);
  const declaration =
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:const\s+)?(?:type|interface|class|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (const match of codeOnly.matchAll(declaration)) {
    const before = codeOnly.slice(0, match.index);
    const depth = (before.match(/\{/g)?.length ?? 0) - (before.match(/\}/g)?.length ?? 0);
    if (depth === 0) return match[1];
  }
  return undefined;
}

function quoteMemberName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function escapeCommentText(text: string): string {
  return text.replaceAll("*/", "*\\/").replaceAll(/\s+/g, " ").trim();
}
