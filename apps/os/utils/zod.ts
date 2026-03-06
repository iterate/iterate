import { z } from "zod";

export const ZodJson = <Z extends z.ZodType<unknown, unknown>>(schema: Z) => {
  return z
    .string()
    .transform((str, ctx) => {
      try {
        return JSON.parse(str);
      } catch {
        ctx.addIssue({ code: "custom", message: "Value is not valid JSON" });
        return z.NEVER;
      }
    })
    .pipe(schema);
};
