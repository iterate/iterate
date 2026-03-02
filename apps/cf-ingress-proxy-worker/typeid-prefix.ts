import { z } from "zod/v4";

export const TypeIdPrefixSchema = z
  .string()
  .trim()
  .default("ipr")
  .transform((value) => value.replace(/_+$/g, ""))
  .refine((value) => /^[a-z]+$/.test(value), {
    message: "TYPEID_PREFIX must contain lowercase letters only",
  });
