// vitest.global-setup.ts — THE BUILD (scripts/build.ts) before any project runs: wrangler.jsonc and
// the two generated modules the worker and the e2e fixtures import (src/generated/*.js — every vitest project
// imports context/worker-loader.ts, the unit tests included). Under a second; the worker itself is
// bundled from src/worker.ts by whoever runs it.
import { build } from "./scripts/build.ts";

export default async function setup(): Promise<void> {
  await build();
}
