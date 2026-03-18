import { ORPCError, os } from "@orpc/server";
import type { HasHeaders, HeaderValuesContext, RequireHeaderOptions } from "./types.ts";

export function requireHeader<TContextKey extends string>(
  options: RequireHeaderOptions<TContextKey>,
) {
  const base = os.$context<HasHeaders & Partial<HeaderValuesContext>>();

  return base.middleware(async ({ context, next }) => {
    const headerValue = context.req.headers.get(options.header)?.trim();

    if (!headerValue) {
      throw new ORPCError(options.missingCode ?? "BAD_REQUEST", {
        message: `Missing required header: ${options.header}`,
      });
    }

    return next({
      context: {
        headerValues: {
          ...(context.headerValues ?? {}),
          [options.as]: headerValue,
        },
      } satisfies HeaderValuesContext,
    });
  });
}
