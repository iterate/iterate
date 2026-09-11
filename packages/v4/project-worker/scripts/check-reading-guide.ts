/** Check the production-backed reading guide's local links without interpreting test semantics.
 * Local versus opt-in deployed proofs are stated in the guide, not guessed from test source. */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const guide = new URL("../docs/reading-guide.md", import.meta.url);
const links = [...readFileSync(guide, "utf8").matchAll(/\]\(([^)]+)\)/g)]
  .map((match) => match[1])
  .filter((target) => !target.startsWith("#") && !/^https?:/.test(target));
const missing = links.filter((target) => !existsSync(new URL(target.split("#")[0], guide)));
if (missing.length > 0)
  throw new Error(`${fileURLToPath(guide)} has missing local links:\n${missing.join("\n")}`);
console.log(`Reading guide: ${links.length} local links resolve.`);
