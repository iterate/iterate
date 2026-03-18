#!/usr/bin/env node

import { createRequire } from "node:module";
import { appScriptBase } from "@iterate-com/shared/jonasland";
import { createCli } from "trpc-cli";
import { devScript, previewScript } from "../scripts/dev.ts";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
  name?: string;
  version?: string;
};

const cli = createCli({
  name: packageJson.name ?? "ws-test-2-cli",
  version: packageJson.version ?? "0.0.0",
  router: appScriptBase.router({
    dev: devScript,
    preview: previewScript,
  }),
});

await cli.run();
