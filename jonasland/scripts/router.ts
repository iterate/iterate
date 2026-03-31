import { os } from "@orpc/server";
import { deploymentRouter } from "./deployments.ts";
import { imageRouter } from "./image.ts";

export const router = os.router({
  deployment: deploymentRouter,
  image: imageRouter,
});
