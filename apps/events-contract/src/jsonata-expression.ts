import jsonata from "jsonata";
import { z } from "zod";

export const JsonataExpression = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      try {
        jsonata(value);
        return true;
      } catch {
        return false;
      }
    },
    {
      message: "Invalid JSONata expression",
    },
  );
