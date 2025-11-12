import * as jsonSchemaToTypescript from "@mmkal/json-schema-to-typescript";
import * as tsParser from "recast/parsers/typescript.js";
import * as recast from "recast";
import * as R from "remeda";
import type { AugmentedCoreReducedState } from "./agent-core-schemas.ts";

/**
 * some tool names use hyphens, so we can't use them directly as identifiers. They also have to be converted in a consistent way.
 * Note that this is lossy (foo-bar and fooBar both become fooBar) so might cause issues if you have two very confusingly similar tool names.
 */
export const toolNameToJsIdentifier = R.toCamelCase;

function makeJsonSchemaJsonSchemaToTypescriptFriendly<T>(jsonSchema: T) {
  return JSON.parse(
    JSON.stringify(jsonSchema, (_key, value) => {
      if (value?.prefixItems) {
        return {
          ...value,
          items: value.prefixItems,
          prefixItems: undefined,
          minItems: value.prefixItems.length,
          maxItems: value.prefixItems.length,
        };
      }
      return value;
    }),
  ) as T;
}

function hashCode(string: string): number {
  let hash = 0;
  for (let i = 0; i < string.length; i++) {
    hash = (hash << 5) - hash + string.charCodeAt(i);
    hash = hash & hash;
  }
  return hash;
}

function jsonSchemaToInlineTypescript(jsonSchema: {}) {
  const originalSchema = jsonSchema;
  const generatedName = `Type_${Date.now()}_${Math.abs(hashCode(JSON.stringify(originalSchema)))}`;
  jsonSchema = makeJsonSchemaJsonSchemaToTypescriptFriendly(originalSchema);
  const uglyRaw = jsonSchemaToTypescript.compileSync(jsonSchema, generatedName, {
    bannerComment: "",
    additionalProperties: false,
  });
  const raw = prettyPrint(uglyRaw);
  const [beforeName, afterName] = raw.split(generatedName);
  if (!afterName) throw new Error(`Expected to find ${generatedName} in code:\n\n${raw}`);
  const inline = afterName.trim().replace(/^=/, "").trim().replace(/;$/, "");
  const rawJsdoc = beforeName
    .trim()
    .replace(/export \w+$/, "")
    .trim();
  const usefulJsdocLines = rawJsdoc.split("\n").filter((line) => {
    const trimmed = line.trim();
    const isMinOrMaxItems = trimmed.startsWith("* @minItems") || trimmed.startsWith("* @maxItems");
    return trimmed && !isMinOrMaxItems;
  });

  const lineStartingWithWord = /^\s*\*\s*\w/;
  const descriptionStartLine = usefulJsdocLines.findIndex((line) =>
    line.match(lineStartingWithWord),
  );
  const descriptionEndLine =
    descriptionStartLine >= 0
      ? descriptionStartLine +
        usefulJsdocLines.slice(descriptionStartLine).findIndex((line) => {
          const isWordyLine = line.trim() === "*" || line.match(lineStartingWithWord);
          return !isWordyLine;
        })
      : -1;

  const description =
    descriptionStartLine >= 0 && descriptionEndLine >= 0
      ? usefulJsdocLines
          .slice(descriptionStartLine, descriptionEndLine)
          .map((line) => line.trim().replace("*", "").trim())
          .join("\n")
          .trim()
      : "";

  const usefulJsdoc = usefulJsdocLines.some((line) => line.match(/\w/))
    ? usefulJsdocLines.join("\n").trim()
    : "";

  const asDef = (name: string, options: { export?: boolean; interface?: boolean } = {}) => {
    let ts = inline;
    if (options.interface && inline.startsWith("{")) ts = `interface ${name} ${ts}`;
    else ts = `type ${name} = ${ts}`;

    if (options.export) ts = `export ${ts}`;
    if (usefulJsdoc) ts = `${usefulJsdoc}\n${ts}`;

    return ts;
  };

  return { raw, inlineType: inline, rawJsdoc, usefulJsdoc, asDef, description };
}

export function generateTypes(
  tools: AugmentedCoreReducedState["runtimeTools"],
  { blocklist = [] as string[] } = {},
) {
  const available: Array<Extract<(typeof tools)[number], { name: string }>> = [];
  const unavailable: typeof tools = [];
  const toolFunctions: Array<() => string> = [];
  const blocklistSet = new Set(blocklist);
  for (const tool of tools) {
    if (!("name" in tool) || blocklistSet.has(tool.name)) {
      unavailable.push(tool);
      continue;
    }
    available.push(tool);

    const rawToolName = tool.name;
    const identifierToolName = toolNameToJsIdentifier(rawToolName);

    toolFunctions.push(() => {
      const inputCode = jsonSchemaToInlineTypescript(
        tool.unfiddledInputJSONSchema?.() || tool.parameters || {},
      );
      const outputCode = tool.unfiddledOutputJSONSchema
        ? jsonSchemaToInlineTypescript(tool.unfiddledOutputJSONSchema()).inlineType
        : "unknown";
      const placeholderArgs = "/* placeholder args */ ...args: unknown[]";
      const placeholderReturnType = "/* placeholder return type */ unknown";

      let fnCode = `declare function ${identifierToolName}(${placeholderArgs}): Promise<${placeholderReturnType}>`;

      if (tool.parameters?.$original === "empty_schema" || inputCode.inlineType === "{}") {
        fnCode = fnCode.replace(placeholderArgs, "");
      } else {
        fnCode = fnCode.replace(placeholderArgs, `input: ${inputCode.inlineType}`);
      }

      fnCode = fnCode.replace(placeholderReturnType, outputCode);

      if (tool.description) {
        fnCode = [
          `/**`,
          `${tool.description
            .trim()
            .split("\n")
            .map((line) => ` * ${line.replaceAll("*/", "*\\/").trim()}`)
            .join("\n")}`,
          ` */`,
          fnCode,
        ].join("\n");
      }
      return fnCode;
    });
  }

  return {
    typescript: () => {
      const strings = toolFunctions.map((fn) => fn());
      return strings.join("\n\n");
    },
    available,
    unavailable,
  };
}

const prettyPrint = (script: string) => {
  try {
    // use recast instead of prettier because it's synchronous and we don't really care all that much about how it looks as long as it's readable
    const ast = recast.parse(script, { parser: tsParser });
    return recast.prettyPrint(ast, {
      quote: "double",
      tabWidth: 2,
      useTabs: false,
      trailingComma: true,
      objectCurlySpacing: true,
      flowObjectCommas: true,
      arrayBracketSpacing: false,
      arrowParensAlways: true,
    }).code;
  } catch (error) {
    throw new Error(
      `Error pretty printing script: ${error instanceof Error ? error.message : String(error)}. Script:\n\n${script}`,
    );
  }
};
