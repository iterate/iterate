import { expectTypeOf } from "expect-type";
import { describe, expect, it } from "vitest";
import z from "zod/v4";
import { typedParse } from "./schema-helpers.ts";

describe("typedParse", () => {
  describe("type inference tests", () => {
    it("should infer exact input and output types for object schemas", () => {
      const User = z.object({
        name: z.string(),
        age: z.number(),
      });

      // Test input type inference
      const input = { name: "Alice", age: 30 };
      expectTypeOf(input).toExtend<z.input<typeof User>>();

      // Test output type inference
      const result = typedParse(User, input);
      expectTypeOf(result).toEqualTypeOf<{ name: string; age: number }>();
    });

    it("should handle schemas with transforms", () => {
      const D = z.object({
        date: z.string().transform((str) => new Date(str)),
      });

      // Input accepts string
      const input = { date: "2024-01-01" };
      expectTypeOf(input).toExtend<z.input<typeof D>>();

      // Output returns Date
      const result = typedParse(D, input);
      expectTypeOf(result).toEqualTypeOf<{ date: Date }>();
    });

    it("should handle optional fields with defaults", () => {
      const Config = z.object({
        theme: z.string().default("light"),
        enabled: z.boolean().optional(),
      });

      // Input doesn't require theme
      const input1 = { enabled: true };
      expectTypeOf(input1).toExtend<z.input<typeof Config>>();

      // Output always has theme
      const result1 = typedParse(Config, input1);
      expectTypeOf(result1).toEqualTypeOf<{ theme: string; enabled?: boolean }>();

      // Can also provide theme explicitly
      const input2 = { theme: "dark" };
      const result2 = typedParse(Config, input2);
      expectTypeOf(result2).toEqualTypeOf<{ theme: string; enabled?: boolean }>();
    });

    it("should handle union types", () => {
      const Message = z.union([
        z.object({ type: z.literal("text"), content: z.string() }),
        z.object({ type: z.literal("image"), url: z.string() }),
      ]);

      const textInput = { type: "text" as const, content: "Hello" };
      const imageInput = { type: "image" as const, url: "http://example.com/img.jpg" };

      // Input types match union
      expectTypeOf(textInput).toExtend<z.input<typeof Message>>();
      expectTypeOf(imageInput).toExtend<z.input<typeof Message>>();

      // Output preserves discriminated union
      const textResult = typedParse(Message, textInput);
      const imageResult = typedParse(Message, imageInput);

      type MessageOutput = { type: "text"; content: string } | { type: "image"; url: string };

      expectTypeOf(textResult).toEqualTypeOf<MessageOutput>();
      expectTypeOf(imageResult).toEqualTypeOf<MessageOutput>();
    });

    it("should handle array schemas", () => {
      const Numbers = z.array(z.number());
      const input = [1, 2, 3];

      expectTypeOf(input).toExtend<z.input<typeof Numbers>>();

      const result = typedParse(Numbers, input);
      expectTypeOf(result).toEqualTypeOf<number[]>();
    });

    it("should handle strict object schemas", () => {
      const strictSchema = z
        .object({
          foo: z.string(),
        })
        .strict();

      const validInput = { foo: "bar" };
      expectTypeOf(validInput).toExtend<z.input<typeof strictSchema>>();

      const result = typedParse(strictSchema, validInput);
      expectTypeOf(result).toEqualTypeOf<{ foo: string }>();
    });
  });

  describe("runtime behavior tests", () => {
    it("should parse valid data", () => {
      const schema = z.object({ name: z.string() });
      const result = typedParse(schema, { name: "Test" });
      expect(result).toEqual({ name: "Test" });
    });

    it("should apply defaults", () => {
      const schema = z.object({
        name: z.string(),
        role: z.string().default("user"),
      });
      const result = typedParse(schema, { name: "Alice" });
      expect(result).toEqual({ name: "Alice", role: "user" });
    });

    it("should throw formatted error for invalid data", () => {
      const schema = z.object({
        name: z.string(),
        age: z.number().min(0),
        email: z.string().email(),
      });

      expect(() => {
        typedParse(schema, {
          name: 123,
          age: -5,
          email: "not-an-email",
        } as any);
      }).toThrow(
        expect.objectContaining({
          message: expect.stringContaining("Validation failed:"),
        }),
      );

      // Check error format
      try {
        typedParse(schema, {
          name: 123,
          age: -5,
          email: "not-an-email",
        } as any);
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("✖ Invalid input: expected string, received number");
        expect(message).toContain("→ at name");
        expect(message).toContain("✖ Too small: expected number to be >=0");
        expect(message).toContain("→ at age");
        expect(message).toContain("✖ Invalid email address");
        expect(message).toContain("→ at email");
        expect(message).toContain("Payload:");
      }
    });

    it("should handle root-level validation errors", () => {
      const schema = z.string();

      try {
        typedParse(schema, 123 as any);
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("✖ Invalid input: expected string, received number");
        // Root level errors don't have a path
        expect(message).not.toContain("→ at");
      }
    });

    it("should preserve non-Zod errors", () => {
      const schema = z.string().transform((val) => {
        if (val === "error") {
          throw new Error("Custom error");
        }
        return val;
      });

      expect(() => {
        typedParse(schema, "error");
      }).toThrow("Custom error");
    });

    it("should work with discriminated unions", () => {
      const schema = z.discriminatedUnion("type", [
        z.object({ type: z.literal("a"), value: z.string() }),
        z.object({ type: z.literal("b"), value: z.number() }),
      ]);

      const resultA = typedParse(schema, { type: "a", value: "test" });
      expect(resultA).toEqual({ type: "a", value: "test" });

      const resultB = typedParse(schema, { type: "b", value: 42 });
      expect(resultB).toEqual({ type: "b", value: 42 });
    });
  });
});
