import { z } from "zod";
import { normalizedItxExpression, type ItxExpressionInput } from "iterate/next/expression";

const IngressConfigured = z.object({
  // The expression codec below validates every step after this outer shape check.
  target: z
    .custom<ItxExpressionInput>((value) => typeof value === "string" || Array.isArray(value))
    .nullable(),
});

/** Apex routing stores the complete capability expression, independently of rewrite aliases. */
export function normalizeIngressConfigured(input: unknown) {
  const { target } = IngressConfigured.parse(input);
  // oxlint-disable-next-line iterate/simple-truthiness-check -- null disables ingress; an empty expression must be rejected by the codec
  if (target === null) return { target: null };
  const expression = normalizedItxExpression(target);
  if (expression[0] !== "itx") throw new Error("ingress target must be rooted at itx");
  return { target: expression };
}
