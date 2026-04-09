import { describe, expect, test } from "vitest";
import {
  CODEMODE_PACKAGE_PROJECT_STARTER,
  DEFAULT_CODEMODE_INPUT,
  formatCodemodeInputForDisplay,
  formatCodemodeProjectFilesYaml,
  parseCodemodeProjectFilesYaml,
  parseStoredCodemodeInput,
  serializeCodemodeInput,
} from "~/lib/codemode-input.ts";

describe("codemode input helpers", () => {
  test("round-trips structured inputs through storage serialization", () => {
    const serialized = serializeCodemodeInput(CODEMODE_PACKAGE_PROJECT_STARTER);

    expect(parseStoredCodemodeInput(serialized)).toEqual(CODEMODE_PACKAGE_PROJECT_STARTER);
  });

  test("treats legacy stored snippets as compiled-script inputs", () => {
    expect(parseStoredCodemodeInput("async ({ ctx }) => ctx.fetch('https://example.com')")).toEqual(
      {
        type: "compiled-script",
        script: "async ({ ctx }) => ctx.fetch('https://example.com')",
      },
    );
  });

  test("parses project file YAML blocks into string maps", () => {
    const yamlText = formatCodemodeProjectFilesYaml(CODEMODE_PACKAGE_PROJECT_STARTER.files);
    const parsed = parseCodemodeProjectFilesYaml(yamlText);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }

    expect(parsed.files["package.json"]).toContain('"openai": "^6.0.0"');
    expect(parsed.files["src/index.ts"]).toContain("getIterateSecret");
  });

  test("formats inputs for display", () => {
    expect(formatCodemodeInputForDisplay(DEFAULT_CODEMODE_INPUT)).toContain("async ({ ctx }) =>");
    expect(formatCodemodeInputForDisplay(CODEMODE_PACKAGE_PROJECT_STARTER)).toContain(
      "entryPoint: src/index.ts",
    );
  });
});
