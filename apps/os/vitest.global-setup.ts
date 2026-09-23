// Prepare the generated modules imported by unit tests and fixtures. Package test scripts build
// the Worker with Vite before Vitest starts; the Worker and E2E projects run that built entry.
import { build } from "./scripts/build.ts";

export default async function setup(): Promise<void> {
  await build();
}
