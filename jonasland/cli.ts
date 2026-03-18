#!/usr/bin/env node

import { createRequire } from "node:module";
import { ORPCError } from "@orpc/server";
import { createCli } from "trpc-cli";
import { z } from "zod/v4";
import { router } from "./scripts/router.ts";

const require = createRequire(import.meta.url);
const packageJson = require("./package.json") as {
  name?: string;
  version?: string;
};

const cli = createCli({
  name: packageJson.name ?? "jonasland-cli",
  version: packageJson.version ?? "0.0.0",
  router,
});

await cli.run({
  // `trpc-cli` supports a top-level `formatError` hook. Without this, its default
  // fallback is to inspect the thrown object, which turns oRPC errors into a noisy
  // stack/object dump instead of a CLI-friendly message:
  // https://github.com/mmkal/trpc-cli#readme
  //
  // The shared oRPC base in `scripts/_cli.ts` already rewrites validation errors
  // into `ORPCError`s whose `.message` is `z.prettifyError(...)`. This hook keeps
  // the terminal output focused on that message instead of the full error object.
  formatError(error) {
    if (error instanceof ORPCError) {
      return error.message;
    }

    // Some handler-local schema parses can still throw a raw ZodError directly.
    // Format those with Zod's first-party pretty printer for consistency with the
    // oRPC path above:
    // https://zod.dev/error-formatting
    if (error instanceof z.ZodError) {
      return z.prettifyError(error);
    }

    return error instanceof Error ? (error.stack ?? error.message) : String(error);
  },
});
