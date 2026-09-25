// This deployment's platform packages (`iterate/*`, zod) as loader modules — written by
// scripts/build.ts as platform-modules.js (gitignored); this declaration lets `tsc` and knip resolve
// the import without it.
import type { PlatformModules } from "../context/module-resolution.ts";
declare const platformModules: PlatformModules;
export default platformModules;
