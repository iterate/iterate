#!/usr/bin/env node

import { appScriptBase } from "@iterate-com/shared/jonasland";
import { createCli } from "trpc-cli";
import manifest from "../src/manifest.ts";
import { devScript, previewScript } from "./dev.ts";

const cli = createCli({
  name: `${manifest.packageName} scripts CLI`,
  version: manifest.version,
  router: appScriptBase.router({
    dev: devScript,
    preview: previewScript,
  }),
});

await cli.run();
