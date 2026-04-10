import YAML from "yaml";
import {
  type CodemodeInput,
  CodemodeInput as CodemodeInputSchema,
} from "@iterate-com/codemode-contract";
import { CODEMODE_OPENAI_PACKAGE_PROJECT_INPUT } from "~/lib/codemode-package-project-openai.ts";
import { CODEMODE_V2_STARTER } from "~/lib/codemode-v2.ts";

export const CODEMODE_PACKAGE_PROJECT_STARTER = CODEMODE_OPENAI_PACKAGE_PROJECT_INPUT;

export const DEFAULT_CODEMODE_INPUT = CodemodeInputSchema.parse({
  type: "compiled-script",
  script: CODEMODE_V2_STARTER,
}) as Extract<CodemodeInput, { type: "compiled-script" }>;

export function serializeCodemodeInput(input: CodemodeInput) {
  return JSON.stringify(input);
}

export function parseStoredCodemodeInput(value: string): CodemodeInput {
  try {
    return CodemodeInputSchema.parse(JSON.parse(value));
  } catch {
    return CodemodeInputSchema.parse({
      type: "compiled-script",
      script: value,
    });
  }
}

export function resolveCodemodeEditorInput(options: {
  input?: string;
  code?: string;
}): CodemodeInput {
  if (options.input?.trim().length) {
    return parseStoredCodemodeInput(options.input);
  }

  if (options.code?.trim().length) {
    return CodemodeInputSchema.parse({
      type: "compiled-script",
      script: options.code,
    });
  }

  return DEFAULT_CODEMODE_INPUT;
}

export function formatCodemodeProjectFilesYaml(files: Record<string, string>) {
  return YAML.stringify(files).trim();
}

export function parseCodemodeProjectFilesYaml(input: string) {
  try {
    const parsed = YAML.parse(input) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false as const,
        error: "Files YAML must be an object keyed by relative file path.",
      };
    }

    const files = Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => {
        if (typeof value !== "string") {
          throw new Error(`File "${key}" must be a string block.`);
        }

        return [key, value];
      }),
    );

    return {
      ok: true as const,
      files,
    };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Invalid files YAML",
    };
  }
}

export function formatCodemodeInputForDisplay(input: CodemodeInput) {
  if (input.type === "compiled-script") {
    return input.script;
  }

  return YAML.stringify({
    entryPoint: input.entryPoint,
    files: input.files,
  }).trim();
}

export function codemodeInputLanguage(input: CodemodeInput) {
  return input.type === "compiled-script" ? ("typescript" as const) : ("text" as const);
}
