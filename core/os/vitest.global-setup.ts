// Prepare the generated modules imported by unit tests and fixtures, with one preset: the seed's
// tests (src/project/templates.test.ts) create from it and prove it is never downloaded.
import { build } from "./scripts/build.ts";

export const PRESET = {
  reference: `github:example/presets#${"b".repeat(40)}&path:starter`,
  files: [
    { path: "package.json", content: '{"main":"worker.ts"}' },
    { path: "worker.ts", content: "export default { fetch: () => new Response('a preset') };" },
  ],
};

export default async function setup(): Promise<void> {
  await build({ templates: [PRESET] });
}
