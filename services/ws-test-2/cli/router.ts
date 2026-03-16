import { scriptCli } from "./_cli.ts";
import { devScript } from "./dev.ts";
import { startScript } from "./start.ts";

export const router = scriptCli.router({
  dev: devScript,
  start: startScript,
});
