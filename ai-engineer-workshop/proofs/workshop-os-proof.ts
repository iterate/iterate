import { os } from "ai-engineer-workshop";
import { z } from "zod";

function expectType<T>(_value: T) {}

export const baseProof = os.handler(async ({ context, input }) => {
  expectType<string>(input.pathPrefix);
  expectType<"debug" | "info" | "warn" | "error">(input.logLevel);
  expectType<{ info: (...args: unknown[]) => void }>(context.logger);

  // @ts-expect-error base procedures should not expose script-specific input
  input.streamPatternSuffix;

  return { ok: true };
});

export const extendedProof = os
  .input(
    z.object({
      streamPatternSuffix: z.string().default("/**"),
      projectSlug: z.string().default("demo"),
    }),
  )
  .handler(async ({ input }) => {
    expectType<string>(input.pathPrefix);
    expectType<"debug" | "info" | "warn" | "error">(input.logLevel);
    expectType<string>(input.streamPatternSuffix);
    expectType<string>(input.projectSlug);

    // @ts-expect-error unknown keys should still fail
    input.missingField;

    return { ok: true };
  });
