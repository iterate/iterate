#!/usr/bin/env node

import { createRequire } from "node:module";
import { createCli } from "trpc-cli";
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

await cli.run();
