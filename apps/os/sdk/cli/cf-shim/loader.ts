import { register } from "node:module";
import { pathToFileURL } from "node:url";

// https://nodejs.org/docs/latest-v24.x/api/module.html#customization-hooks
register("./sdk/cli/cf-shim/hooks.mjs", pathToFileURL("./"));
