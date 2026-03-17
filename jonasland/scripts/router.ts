import { deploymentsRouter } from "./deployments.ts";
import { scriptCli } from "./_cli.ts";
import { helloScript } from "./example/hello.ts";

export const router = scriptCli.router({
  deployments: deploymentsRouter,
  example: {
    hello: helloScript,
  },
});
