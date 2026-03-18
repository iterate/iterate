import { deploymentRouter } from "./deployments.ts";
import { imageRouter } from "./image.ts";
import { scriptCli } from "./_cli.ts";
import { helloScript } from "./example/hello.ts";

export const router = scriptCli.router({
  deployment: deploymentRouter,
  deployments: deploymentRouter,
  image: imageRouter,
  example: {
    hello: helloScript,
  },
});
