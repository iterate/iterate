import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export * from "../apps/events-contract/src/sdk.ts";
export {
  defineProcessor,
  type Processor,
} from "../apps/events/src/durable-objects/define-processor.ts";

export function getDefaultWorkshopPathPrefix() {
  return normalizePathPrefix(
    process.env.WORKSHOP_PATH_PREFIX || `/${execSync("id -un").toString().trim()}`,
  );
}

export function isMainModule(importMetaUrl: string) {
  if (!process.argv[1]) {
    return false;
  }

  return importMetaUrl === pathToFileURL(resolve(process.argv[1])).href;
}

export function runWorkshopMain(importMetaUrl: string, run: (pathPrefix: string) => Promise<void>) {
  if (!isMainModule(importMetaUrl)) {
    return;
  }

  void run(getDefaultWorkshopPathPrefix()).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export function normalizePathPrefix(pathPrefix: string) {
  return pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
}
