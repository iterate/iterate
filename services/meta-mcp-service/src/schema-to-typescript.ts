import * as jsonSchemaToTypeScript from "@mmkal/json-schema-to-typescript";

function toPascalCase(value: string) {
  return value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join("");
}

function declarationName(toolPath: string, suffix: "Input" | "Output") {
  const baseName = toPascalCase(toolPath) || "Tool";
  return `${baseName}${suffix}`;
}

function normalizeDeclaration(source: string) {
  return source.trim();
}

function fallbackDeclaration(name: string) {
  return `export type ${name} = unknown;`;
}

export function renderSchemaTypeScript(params: {
  toolPath: string;
  kind: "input" | "output";
  schema: unknown;
}) {
  if (!params.schema || typeof params.schema !== "object" || Array.isArray(params.schema)) {
    return undefined;
  }

  const name = declarationName(params.toolPath, params.kind === "input" ? "Input" : "Output");

  try {
    return normalizeDeclaration(
      jsonSchemaToTypeScript.compileSync(
        params.schema as Parameters<typeof jsonSchemaToTypeScript.compileSync>[0],
        name,
        {
          additionalProperties: false,
          bannerComment: "",
          format: false,
          strictIndexSignatures: false,
          unknownAny: true,
        },
      ),
    );
  } catch {
    return fallbackDeclaration(name);
  }
}
