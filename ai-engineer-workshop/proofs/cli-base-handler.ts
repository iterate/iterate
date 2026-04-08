import { os, runIfMain } from "ai-engineer-workshop";

export const handler = os.handler(async ({ input }) => {
  return {
    pathPrefix: input.pathPrefix,
    logLevel: input.logLevel,
  };
});

runIfMain(import.meta.url, handler);
