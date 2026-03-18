#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createCli } from "trpc-cli";
import { createServiceRequestLogger } from "@iterate-com/shared/jonasland";
import { router as scriptsRouter } from "../scripts/router.ts";
import { getEnv, getStore, serviceName, type RegistryContext } from "./server/context.ts";
import { registryRouter } from "./server/router.ts";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
  name?: string;
  version?: string;
};

function createCliContext(): RegistryContext {
  const env = getEnv();
  const requestId = randomUUID();

  return {
    requestId,
    serviceName,
    log: createServiceRequestLogger({
      requestId,
      method: "CLI",
      path: `/cli ${process.argv.slice(2).join(" ")}`.trimEnd(),
    }),
    getStore,
    env,
  };
}

const router = {
  ...registryRouter,
  scripts: scriptsRouter,
};

const cli = createCli({
  name: packageJson.name ?? "registry-cli",
  version: packageJson.version ?? "0.0.0",
  router,
  context: createCliContext(),
});

await cli.run();
