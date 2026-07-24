import { readFile } from "node:fs/promises";

const browserEntrypoint = new URL("../dist/starter-apps/todo/client.mjs", import.meta.url);
const browserSource = await readFile(browserEntrypoint, "utf8");
const browserImports = [
  ...browserSource.matchAll(/^(?:import|export)(?:[^"'\n]*?from)?["']([^"']+)["'];?/gm),
  ...browserSource.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
].map((match) => match[1]!);

if (browserImports.length > 0) {
  throw new Error(
    [
      "The Todo browser asset relies on imports a browser cannot resolve:",
      ...browserImports.toSorted().map((specifier) => `- ${specifier}`),
      "Bundle these dependencies into the Todo browser artifact.",
    ].join("\n"),
  );
}
