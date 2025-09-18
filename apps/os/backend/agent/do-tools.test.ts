import { describe, expectTypeOf, it } from "vitest";
import z from "zod";
import { defineDOTools } from "./do-tools.ts";

describe("IterateAgent", () => {
  it("should preserve output types", () => {
    const tools = defineDOTools({
      getHoroscope: {
        description: "Get a horoscope",
        input: z.object({
          birthDate: z.string(),
        }),
      },
    });

    expectTypeOf(() => tools.$infer.inputTypes).returns.toEqualTypeOf<{
      getHoroscope: { birthDate: string };
    }>();

    type ToolsInterface = typeof tools.$infer.interface;
    type Inputs = typeof tools.$infer.inputTypes;
    class TestDO implements ToolsInterface {
      getHoroscope(input: Inputs["getHoroscope"]) {
        const month = new Date(input.birthDate).getMonth();
        return { horoscope: month === 5 ? "You are a bad person" : "You are a good person" };
      }

      getFullname(input: { firstName: string; lastName: string }) {
        return { fullName: `${input.firstName} ${input.lastName}` };
      }
    }

    // most tools don't define output types and I just wanted to be sure that doing
    // `class IterateAgent implements ToolsInterface` still allows for output type inference
    expectTypeOf(TestDO)
      .instance.toHaveProperty("getHoroscope")
      .toEqualTypeOf<(input: { birthDate: string }) => { horoscope: string }>();
  });
});
