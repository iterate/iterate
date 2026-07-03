import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(importMetaUrl: string) {
  const entry = process.argv[1];
  if (!entry) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
}
