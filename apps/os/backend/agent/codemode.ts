import * as quicktype from "quicktype-core";
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

function jsonSchemaToInlineTypescript(generatedName: string, jsonSchema: {}) {
  const originalSchema = jsonSchema;

  jsonSchema = makeJsonSchemaJsonSchemaToTypescriptFriendly(originalSchema);
  const uglyRaw = jsonSchemaToTypescript.compileSync(jsonSchema, generatedName, {
    bannerComment: "",
    additionalProperties: false,
  });
  let raw = prettyPrint(uglyRaw).trim();

  if (Object.keys(originalSchema).filter((key) => key !== "$schema").length === 0) {
    raw = `export type ${generatedName} = unknown`;
  }

  const rawJsdoc = raw.split(/\nexport \w+$/)[0].trim();
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

  return {
    raw,
    cleanedUp: raw.replace(rawJsdoc, usefulJsdoc).trim(),
    rawJsdoc,
    usefulJsdoc,
    description,
  };
}

export function generateTypes(
  tools: AugmentedCoreReducedState["runtimeTools"],
  { blocklist = [] as string[], outputSamples = {} as Record<string, unknown[]> } = {},
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
      let fnCode = `declare function ${identifierToolName}(input: ${identifierToolName}.Input): Promise<${identifierToolName}.Output>`;

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

      const inputTypes = jsonSchemaToInlineTypescript(
        "Input",
        tool.unfiddledInputJSONSchema?.() || tool.parameters || {},
      ).cleanedUp;

      let outputTypes = jsonSchemaToInlineTypescript(
        "Output",
        tool.unfiddledOutputJSONSchema?.() || {},
      ).cleanedUp;

      if (!outputTypes.includes("\n") && tool.name in outputSamples) {
        const jsonInput = quicktype.jsonInputForTargetLanguage("typescript");
        jsonInput.addSourceSync({
          name: "Output",
          samples: outputSamples[tool.name].map((sample) => JSON.stringify(sample)),
        });
        const inputData = new quicktype.InputData();
        inputData.addInput(jsonInput);
        const generation = quicktype.quicktypeMultiFileSync({
          inputData,
          lang: "typescript",
          rendererOptions: {
            "just-types": true,
            "prefer-unions": true,
            module: true,
          },
        });
        const result = generation.get("stdout")?.lines.join("\n").trim();
        if (result) outputTypes = result;
      }

      const namespaceCodeParts: Record<string, string> = {};

      if (!inputTypes.includes("\n")) {
        // single line input type, probably something like `export type Input = unknown` or `export interface Input {}`, let's inline it
        const inline = inlineType(inputTypes);
        fnCode = fnCode.replace(`(input: ${identifierToolName}.Input)`, `(input: ${inline})`);
      } else {
        namespaceCodeParts.input = inputTypes;
      }

      if (!outputTypes.includes("\n")) {
        // single line output type, probably something like `export type Output = unknown` or `export interface Output {}`, let's inline it
        const inline = inlineType(outputTypes);
        fnCode = fnCode.replace(`: Promise<${identifierToolName}.Output>`, `: Promise<${inline}>`);
      } else {
        namespaceCodeParts.output = outputTypes;
      }

      const namespaceParts = Object.entries(namespaceCodeParts);
      if (namespaceParts.length > 0) {
        const s = namespaceParts.length > 1 ? "s" : "";
        return prettyPrint(`
          /** Namespace containing the ${namespaceParts.map(([name]) => name).join(" and ")} type${s} for the ${identifierToolName} tool. */
          declare namespace ${identifierToolName} {
            ${namespaceParts.map((e) => e[1]).join("\n\n")}
          }
          ${fnCode}
        `);
      }

      return prettyPrint(fnCode);
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

export const prettyPrint = (script: string) => {
  try {
    // use recast instead of prettier because it's synchronous and we don't really care all that much about how it looks as long as it's readable
    const ast = recast.parse(script, { parser: tsParser });
    const pretty = recast.prettyPrint(ast, {
      quote: "double",
      tabWidth: 2,
      useTabs: false,
      trailingComma: true,
      objectCurlySpacing: true,
      flowObjectCommas: true,
      arrayBracketSpacing: false,
      arrowParensAlways: true,
    });
    return fixJsDocIndent(pretty.code);
  } catch (error) {
    throw new Error(
      `Error pretty printing script: ${error instanceof Error ? error.message : String(error)}. Script:\n\n${script}`,
    );
  }
};

const inlineType = (namedType: string) => {
  if (namedType.includes("\n")) {
    throw new Error(`Type too complicated to inline, this is a dumb function:\n\n${namedType}`);
  }
  return namedType
    .replace(/^export /, "")
    .replace(/^type \w+ = /, "")
    .replace(/^interface \w+ /, "");
};

// recast messes with the indentation of jsdoc comments. it bugs me so maybe it bugs LLMs too
const fixJsDocIndent = (code: string) => {
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "/**") {
      const indent = line.split("/**")[0];
      i++;
      while (lines[i].trim().startsWith("*")) {
        lines[i] = indent + " " + lines[i].trimStart();
        i++;
      }
    }
  }
  return lines.join("\n");
};
