import { z } from "zod";

function looksLikeJsonataExpression(value: string) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const stack: string[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of trimmed) {
    if (quote != null) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === quote) {
        quote = null;
      }

      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
      continue;
    }

    if (char === ")" || char === "]" || char === "}") {
      const opener = stack.pop();
      if (
        (char === ")" && opener !== "(") ||
        (char === "]" && opener !== "[") ||
        (char === "}" && opener !== "{")
      ) {
        return false;
      }
    }
  }

  if (quote != null || stack.length > 0) {
    return false;
  }

  return !/(?:[=+\-*/%&,?:]|\b(?:and|or|in)\b|[([{])\s*$/i.test(trimmed);
}

export const JsonataExpression = z
  .string()
  .trim()
  .min(1)
  .refine((value) => looksLikeJsonataExpression(value), {
    message: "Invalid JSONata expression",
  });
