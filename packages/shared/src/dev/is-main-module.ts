import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the module at `importMetaUrl` is the entrypoint the process was
 * started with (`tsx foo.ts`), as opposed to being imported by another module.
 * Pass `import.meta.url`.
 */
export function isMainModule(importMetaUrl: string) {
  const entry = process.argv[1];
  if (!entry) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
}
