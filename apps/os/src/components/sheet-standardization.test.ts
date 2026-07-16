import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const productSourceRoots = [
  "apps/auth-contract/src",
  "apps/auth-example/src",
  "apps/auth/src",
  "apps/dummy-petshop/src",
  "apps/iterate-com/backend",
  "apps/mobile/src",
  "apps/os/src",
  "apps/semaphore/src",
  "apps/streams-example-app/src",
  "apps/tunnels/src",
].map((path) => resolve(repositoryRoot, path));

test("product right-edge overlays use the shared Sheet primitive", () => {
  const violations = productSourceRoots.flatMap((sourceRoot) =>
    sourceFiles(sourceRoot).flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return [...source.matchAll(/className="([^"]+)"/g)]
        .filter((match) => isCustomRightEdgeOverlay(match[1] ?? ""))
        .map(() => relative(repositoryRoot, filePath));
    }),
  );

  expect(
    violations,
    "Custom fixed/absolute right-edge overlays bypass focus trapping, Escape/backdrop dismissal, and the product's standard Sheet styling. Compose @iterate-com/ui/components/sheet instead.",
  ).toEqual([]);
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".tsx") ? [path] : [];
  });
}

function isCustomRightEdgeOverlay(className: string): boolean {
  const tokens = new Set(
    className
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => token.split(":").at(-1)),
  );
  const positioned = tokens.has("fixed") || tokens.has("absolute");
  const fillsViewportHeight =
    tokens.has("inset-y-0") || (tokens.has("top-0") && tokens.has("bottom-0"));
  return positioned && fillsViewportHeight && tokens.has("right-0");
}
