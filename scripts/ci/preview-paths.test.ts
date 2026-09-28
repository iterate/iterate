import { expect, test } from "vitest";
import { touchesPreview } from "./preview-paths.ts";

// GitHub's `paths` semantics: any file whose last matching pattern is a positive one triggers.
test.for([
  { files: ["apps/os/src/worker.ts"], preview: true },
  { files: ["configs/default/AGENTS.md"], preview: true },
  { files: ["package.json"], preview: true },
  { files: [".depot/workflows/preview-os.yml"], preview: true },
  // the root manifest only: an app's own package.json is inside its app's pattern
  { files: ["apps/spa/package.json"], preview: false },
  { files: ["docs/depot-ci.md", "lint/rules/no-describe.ts"], preview: false },
  // firmware ships as GitHub releases, never in Kit's Worker
  { files: ["apps/kit/firmware/main/main.c"], preview: false },
  { files: ["apps/kit/firmware/main/main.c", "apps/kit/src/server.ts"], preview: true },
  { files: [".depot/workflows/lint-typecheck.yml", "scripts/ci/preview-paths.ts"], preview: false },
  { files: [], preview: false },
])("$files touches a preview path: $preview", ({ files, preview }) => {
  expect(touchesPreview(files)).toBe(preview);
});
