import { ORPCError, ValidationError, onError, os as osBase } from "@orpc/server";
import type { TrpcCliMeta } from "trpc-cli";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod/v4";

// oRPC recommends normalizing ValidationError instances in an onError interceptor
// before they escape the procedure boundary:
// https://orpc.dev/docs/advanced/validation-errors
//
// We rebuild a ZodError from the standard-schema issues so we can use Zod's own
// first-party formatters:
// https://zod.dev/error-formatting
//
// The main goal here is to replace the generic "Input validation failed" message
// with a path-aware human-readable message while still preserving structured data
// on `error.data` for any caller that wants machine-readable field errors.
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
} as const;

function colorize(stream: NodeJS.WriteStream, color: string, value: string) {
  if (!stream.isTTY) return value;
  return `${color}${value}${ansi.reset}`;
}

export const logParsedInputMiddleware = osBase.middleware(async ({ next }, input: unknown) => {
  const stream = process.stderr;
  const yamlInput = stringifyYaml(input ?? {}, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
  }).trim();
  const formattedInput = (yamlInput || "{}")
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

  stream.write(
    [
      "",
      colorize(stream, `${ansi.bold}${ansi.cyan}`, "Jonasland oRPC CLI"),
      colorize(stream, `${ansi.bold}${ansi.white}`, "Input:"),
      formattedInput,
      "",
      "",
    ].join("\n"),
  );

  return next();
});

const cliBase = osBase
  .$config({
    initialInputValidationIndex: Number.NEGATIVE_INFINITY,
    initialOutputValidationIndex: Number.NEGATIVE_INFINITY,
  })
  .use(logParsedInputMiddleware)
  .$meta<TrpcCliMeta>({});

export const scriptCli = cliBase.use(
  onError((error) => {
    if (
      error instanceof ORPCError &&
      error.code === "BAD_REQUEST" &&
      error.cause instanceof ValidationError
    ) {
      // oRPC exposes validation failures as standard-schema issues. In this repo
      // our inputs are Zod schemas, so converting back to ZodError gives us
      // `z.prettifyError` for terminal output and `z.flattenError` for structured
      // field-level details.
      const ValidationZodError = new z.ZodError(error.cause.issues as z.core.$ZodIssue[]);

      throw new ORPCError("INPUT_VALIDATION_FAILED", {
        status: 422,
        message: z.prettifyError(ValidationZodError),
        data: z.flattenError(ValidationZodError),
        cause: error.cause,
      });
    }
  }),
);
