import { describe, expect, test, vi } from "vitest";
import * as jsonSchemaToTypeScript from "@mmkal/json-schema-to-typescript";
import { renderSchemaTypeScript } from "./schema-to-typescript.ts";

describe("renderSchemaTypeScript", () => {
  test("renders required and optional object properties", () => {
    const rendered = renderSchemaTypeScript({
      toolPath: "weather.get_forecast",
      kind: "input",
      schema: {
        type: "object",
        properties: {
          city: { type: "string" },
          days: { type: "integer" },
        },
        required: ["city"],
      },
    });

    expect(rendered).toContain("export interface WeatherGetForecastInput");
    expect(rendered).toContain("city: string");
    expect(rendered).toContain("days?: number");
  });

  test("renders enums, arrays, and nullable unions", () => {
    const rendered = renderSchemaTypeScript({
      toolPath: "weather.get_forecast",
      kind: "output",
      schema: {
        type: "object",
        properties: {
          status: { enum: ["sunny", "rainy"] },
          highs: { type: "array", items: { type: "number" } },
          note: { type: ["string", "null"] },
        },
        required: ["status", "highs"],
      },
    });

    expect(rendered).toContain('status: ("sunny" | "rainy")');
    expect(rendered).toContain("highs: number[]");
    expect(rendered).toContain("note?: (string | null)");
  });

  test("falls back to unknown on invalid schemas", () => {
    vi.spyOn(jsonSchemaToTypeScript, "compileSync").mockImplementationOnce(() => {
      throw new Error("boom");
    });

    const rendered = renderSchemaTypeScript({
      toolPath: "weather.get_forecast",
      kind: "input",
      schema: {
        type: "object",
      },
    });

    expect(rendered).toBe("export type WeatherGetForecastInput = unknown;");
  });
});
