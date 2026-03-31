export type JsonSchema = boolean | Record<string, unknown>;

export interface JsonSchemaToolDescriptor {
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

export type JsonSchemaToolDescriptors = Record<string, JsonSchemaToolDescriptor>;

const JS_RESERVED = new Set([
  "abstract",
  "arguments",
  "await",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "double",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "float",
  "for",
  "function",
  "goto",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "int",
  "interface",
  "let",
  "long",
  "native",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "short",
  "static",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "volatile",
  "while",
  "with",
  "yield",
]);

export function sanitizeToolName(name: string) {
  if (!name) return "_";

  let sanitized = name.replace(/[-.\s]/g, "_");
  sanitized = sanitized.replace(/[^a-zA-Z0-9_$]/g, "");

  if (!sanitized) return "_";
  if (/^[0-9]/.test(sanitized)) sanitized = `_${sanitized}`;
  if (JS_RESERVED.has(sanitized)) sanitized = `${sanitized}_`;

  return sanitized;
}

function toPascalCase(value: string) {
  return value
    .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function escapeControlChar(ch: string) {
  const code = ch.charCodeAt(0);
  if (code <= 31 || code === 127) {
    return `\\u${code.toString(16).padStart(4, "0")}`;
  }

  return ch;
}

function quoteProp(name: string) {
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
    let escaped = "";

    for (const ch of name) {
      if (ch === "\\") escaped += "\\\\";
      else if (ch === '"') escaped += '\\"';
      else if (ch === "\n") escaped += "\\n";
      else if (ch === "\r") escaped += "\\r";
      else if (ch === "\t") escaped += "\\t";
      else if (ch === "\u2028") escaped += "\\u2028";
      else if (ch === "\u2029") escaped += "\\u2029";
      else escaped += escapeControlChar(ch);
    }

    return `"${escaped}"`;
  }

  return name;
}

function escapeStringLiteral(value: string) {
  let output = "";

  for (const ch of value) {
    if (ch === "\\") output += "\\\\";
    else if (ch === '"') output += '\\"';
    else if (ch === "\n") output += "\\n";
    else if (ch === "\r") output += "\\r";
    else if (ch === "\t") output += "\\t";
    else if (ch === "\u2028") output += "\\u2028";
    else if (ch === "\u2029") output += "\\u2029";
    else output += escapeControlChar(ch);
  }

  return output;
}

function escapeJsDoc(text: string) {
  return text.replace(/\*\//g, "*\\/");
}

function isJsonSchemaObject(schema: JsonSchema): schema is Record<string, unknown> {
  return typeof schema === "object" && schema !== null;
}

function resolveRef(ref: string, root: JsonSchema) {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return null;

  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = root;

  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return null;
  }

  if (typeof current === "boolean") return current;
  if (typeof current !== "object" || current === null) return null;
  return current as Record<string, unknown>;
}

function applyNullable(result: string, schema: Record<string, unknown> | undefined) {
  if (result !== "unknown" && result !== "never" && schema?.nullable === true) {
    return `${result} | null`;
  }

  return result;
}

function jsonSchemaToTypeString(
  schema: JsonSchema,
  indent: string,
  context: {
    root: JsonSchema;
    depth: number;
    seen: Set<JsonSchema>;
    maxDepth: number;
  },
): string {
  if (typeof schema === "boolean") {
    return schema ? "unknown" : "never";
  }

  if (context.depth >= context.maxDepth) {
    return "unknown";
  }

  if (context.seen.has(schema)) {
    return "unknown";
  }

  context.seen.add(schema);
  const nextContext = {
    ...context,
    depth: context.depth + 1,
  };

  try {
    if (typeof schema.$ref === "string") {
      const resolved = resolveRef(schema.$ref, context.root);
      if (!resolved) return "unknown";
      return applyNullable(jsonSchemaToTypeString(resolved, indent, nextContext), schema);
    }

    if (Array.isArray(schema.anyOf)) {
      return applyNullable(
        schema.anyOf
          .map((item) => jsonSchemaToTypeString(item as JsonSchema, indent, nextContext))
          .join(" | "),
        schema,
      );
    }

    if (Array.isArray(schema.oneOf)) {
      return applyNullable(
        schema.oneOf
          .map((item) => jsonSchemaToTypeString(item as JsonSchema, indent, nextContext))
          .join(" | "),
        schema,
      );
    }

    if (Array.isArray(schema.allOf)) {
      return applyNullable(
        schema.allOf
          .map((item) => jsonSchemaToTypeString(item as JsonSchema, indent, nextContext))
          .join(" & "),
        schema,
      );
    }

    if (Array.isArray(schema.enum)) {
      if (schema.enum.length === 0) return "never";

      return applyNullable(
        schema.enum
          .map((value) => {
            if (value === null) return "null";
            if (typeof value === "string") return `"${escapeStringLiteral(value)}"`;
            if (typeof value === "object") return JSON.stringify(value) ?? "unknown";
            return String(value);
          })
          .join(" | "),
        schema,
      );
    }

    if (schema.const !== undefined) {
      return applyNullable(
        schema.const === null
          ? "null"
          : typeof schema.const === "string"
            ? `"${escapeStringLiteral(schema.const)}"`
            : typeof schema.const === "object"
              ? (JSON.stringify(schema.const) ?? "unknown")
              : String(schema.const),
        schema,
      );
    }

    const type = schema.type;

    if (type === "string") return applyNullable("string", schema);
    if (type === "number" || type === "integer") return applyNullable("number", schema);
    if (type === "boolean") return applyNullable("boolean", schema);
    if (type === "null") return "null";

    if (type === "array") {
      const prefixItems = schema.prefixItems;

      if (Array.isArray(prefixItems)) {
        return applyNullable(
          `[${prefixItems
            .map((item) => jsonSchemaToTypeString(item as JsonSchema, indent, nextContext))
            .join(", ")}]`,
          schema,
        );
      }

      if (Array.isArray(schema.items)) {
        return applyNullable(
          `[${schema.items
            .map((item) => jsonSchemaToTypeString(item as JsonSchema, indent, nextContext))
            .join(", ")}]`,
          schema,
        );
      }

      if (isJsonSchemaObject(schema.items as JsonSchema)) {
        return applyNullable(
          `${jsonSchemaToTypeString(schema.items as JsonSchema, indent, nextContext)}[]`,
          schema,
        );
      }

      return applyNullable("unknown[]", schema);
    }

    if (type === "object" || isJsonSchemaObject(schema.properties as JsonSchema)) {
      const properties = isJsonSchemaObject(schema.properties as JsonSchema)
        ? (schema.properties as Record<string, JsonSchema>)
        : {};
      const required = new Set(
        Array.isArray(schema.required)
          ? schema.required.filter((value): value is string => typeof value === "string")
          : [],
      );
      const lines: string[] = [];

      for (const [propName, propSchema] of Object.entries(properties)) {
        if (typeof propSchema === "boolean") {
          const boolType = propSchema ? "unknown" : "never";
          const optionalMark = required.has(propName) ? "" : "?";
          lines.push(`${indent}    ${quoteProp(propName)}${optionalMark}: ${boolType};`);
          continue;
        }

        const propType = jsonSchemaToTypeString(propSchema, `${indent}    `, nextContext);
        const optionalMark = required.has(propName) ? "" : "?";
        const desc =
          typeof propSchema.description === "string" ? propSchema.description : undefined;
        const format = typeof propSchema.format === "string" ? propSchema.format : undefined;

        if (desc || format) {
          const descText = desc ? escapeJsDoc(desc.replace(/\r?\n/g, " ")) : undefined;
          const formatTag = format ? `@format ${escapeJsDoc(format)}` : undefined;

          if (descText && formatTag) {
            lines.push(`${indent}    /**`);
            lines.push(`${indent}     * ${descText}`);
            lines.push(`${indent}     * ${formatTag}`);
            lines.push(`${indent}     */`);
          } else {
            lines.push(`${indent}    /** ${descText ?? formatTag} */`);
          }
        }

        lines.push(`${indent}    ${quoteProp(propName)}${optionalMark}: ${propType};`);
      }

      if (schema.additionalProperties) {
        const valueType =
          schema.additionalProperties === true
            ? "unknown"
            : jsonSchemaToTypeString(
                schema.additionalProperties as JsonSchema,
                `${indent}    `,
                nextContext,
              );
        lines.push(`${indent}    [key: string]: ${valueType};`);
      }

      if (lines.length === 0) {
        if (schema.additionalProperties === false) {
          return applyNullable("{}", schema);
        }

        return applyNullable("Record<string, unknown>", schema);
      }

      return applyNullable(`{\n${lines.join("\n")}\n${indent}}`, schema);
    }

    if (Array.isArray(type)) {
      return applyNullable(
        type
          .map((value) => {
            if (value === "string") return "string";
            if (value === "number" || value === "integer") return "number";
            if (value === "boolean") return "boolean";
            if (value === "null") return "null";
            if (value === "array") return "unknown[]";
            if (value === "object") return "Record<string, unknown>";
            return "unknown";
          })
          .join(" | "),
        schema,
      );
    }

    return "unknown";
  } finally {
    context.seen.delete(schema);
  }
}

export function jsonSchemaToType(schema: JsonSchema, typeName: string) {
  return `type ${typeName} = ${jsonSchemaToTypeString(schema, "", {
    root: schema,
    depth: 0,
    seen: new Set(),
    maxDepth: 20,
  })}`;
}

function extractJsonSchemaDescriptions(schema: JsonSchema) {
  const descriptions: Record<string, string> = {};

  if (!isJsonSchemaObject(schema)) {
    return descriptions;
  }

  if (!isJsonSchemaObject(schema.properties as JsonSchema)) {
    return descriptions;
  }

  for (const [fieldName, propSchema] of Object.entries(
    schema.properties as Record<string, JsonSchema>,
  )) {
    if (
      isJsonSchemaObject(propSchema) &&
      typeof propSchema.description === "string" &&
      propSchema.description.length > 0
    ) {
      descriptions[fieldName] = propSchema.description;
    }
  }

  return descriptions;
}

export function generateTypesFromJsonSchema(tools: JsonSchemaToolDescriptors) {
  let availableTools = "";
  let availableTypes = "";

  for (const [toolName, tool] of Object.entries(tools)) {
    const safeName = sanitizeToolName(toolName);
    const typeName = toPascalCase(safeName);

    try {
      const inputType = jsonSchemaToType(tool.inputSchema, `${typeName}Input`);
      const outputType = tool.outputSchema
        ? jsonSchemaToType(tool.outputSchema, `${typeName}Output`)
        : `type ${typeName}Output = unknown`;

      availableTypes += `\n${inputType.trim()}`;
      availableTypes += `\n${outputType.trim()}`;

      const paramLines = Object.entries(extractJsonSchemaDescriptions(tool.inputSchema)).map(
        ([fieldName, description]) => `@param input.${fieldName} - ${description}`,
      );
      const jsdocLines = tool.description?.trim()
        ? [escapeJsDoc(tool.description.trim().replace(/\r?\n/g, " "))]
        : [escapeJsDoc(toolName)];

      for (const paramLine of paramLines) {
        jsdocLines.push(escapeJsDoc(paramLine.replace(/\r?\n/g, " ")));
      }

      const jsdocBody = jsdocLines.map((line) => `\t * ${line}`).join("\n");
      availableTools += `\n\t/**\n${jsdocBody}\n\t */`;
      availableTools += `\n\t${safeName}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
      availableTools += "\n";
    } catch {
      availableTypes += `\ntype ${typeName}Input = unknown`;
      availableTypes += `\ntype ${typeName}Output = unknown`;
      availableTools += `\n\t/**\n\t * ${escapeJsDoc(toolName)}\n\t */`;
      availableTools += `\n\t${safeName}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
      availableTools += "\n";
    }
  }

  return `
${availableTypes}
declare const codemode: {${availableTools}}
  `.trim();
}
