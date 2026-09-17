// vitest.global-setup.ts — THE BUILD (scripts/build.ts) before any project runs: wrangler.jsonc, the
// two generated modules the worker and the demo import (src/generated/*.js — every lane imports
// context/worker-loader.ts, the unit tests included), and the console bundle the e2e worker serves as
// assets. Under a second; the worker itself is bundled from src/worker.ts by whoever runs it.
import { build } from "./scripts/build.ts";

export default async function setup(): Promise<void> {
  await build();
}
