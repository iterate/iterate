import { z } from "zod/v4";

export const jsonInput = z.string().transform((raw, ctx) => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Invalid JSON",
    });
    return z.NEVER;
  }
});
