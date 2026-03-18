#!/usr/bin/env node

import { appScriptBase } from "@iterate-com/shared/jonasland";
import { createCli } from "trpc-cli";
import { appManifest } from "../src/manifest.ts";
import { devScript, previewScript } from "./dev.ts";

const cli = createCli({
  name: `${appManifest.packageName} scripts CLI`,
  version: appManifest.version,
  router: appScriptBase.router({
    dev: devScript,
    preview: previewScript,
  }),
});

await cli.run();
