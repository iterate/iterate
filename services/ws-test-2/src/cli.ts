#!/usr/bin/env node

import { createRequire } from "node:module";
import { createCli } from "trpc-cli";
import { cliBase } from "../scripts/_cli.ts";
import { devScript, previewScript } from "../scripts/dev.ts";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
  name?: string;
  version?: string;
};

const cli = createCli({
  name: packageJson.name ?? "ws-test-2-cli",
  version: packageJson.version ?? "0.0.0",
  router: cliBase.router({
    dev: devScript,
    preview: previewScript,
  }),
});

await cli.run();
