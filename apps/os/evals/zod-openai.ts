import { z } from "zod";
import type { zodTextFormat as openAIBrokenZodTextFormatButWhichHasCorrectTypeScriptTypes } from "openai/helpers/zod";

/** fix openai's broken implementation which gets `400: expected object but got string` */
export const zodTextFormat: typeof openAIBrokenZodTextFormatButWhichHasCorrectTypeScriptTypes = (
  zodSchema,
  name,
) => {
  return {
    type: "json_schema",
    schema: z.toJSONSchema(zodSchema),
    name,
  } as ReturnType<typeof openAIBrokenZodTextFormatButWhichHasCorrectTypeScriptTypes> as never;
};
