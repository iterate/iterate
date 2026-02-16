import { createCli } from "trpc-cli";
import { router } from "./router.ts";

export const cli = createCli({
  router,
  name: "iterate",
  version: "0.0.1",
  description: "Iterate CLI",
});
