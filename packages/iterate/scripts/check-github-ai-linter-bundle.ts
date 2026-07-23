import { readFile } from "node:fs/promises";

const entrypoint = new URL("../dist/github-ai-linter/configured-worker.mjs", import.meta.url);
const pending = [entrypoint];
const visited = new Set<string>();
const unsupported = new Set<string>();

while (pending.length > 0) {
  const moduleUrl = pending.pop()!;
  if (visited.has(moduleUrl.href)) continue;
  visited.add(moduleUrl.href);
  const source = await readFile(moduleUrl, "utf8");
  const specifiers = [
    ...source.matchAll(/^(?:import|export)\s+(?:[^"'\n]*?\sfrom\s+)?["']([^"']+)["'];?$/gm),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]!);

  for (const specifier of specifiers) {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      pending.push(new URL(specifier, moduleUrl));
    } else if (
      !specifier.startsWith("cloudflare:") &&
      specifier !== "iterate:github-ai-linter-config"
    ) {
      unsupported.add(specifier);
    }
  }
}

if (unsupported.size > 0) {
  throw new Error(
    [
      "The configured GitHub AI linter worker relies on packages its host does not install:",
      ...[...unsupported].toSorted().map((specifier) => `- ${specifier}`),
      "Bundle these dependencies into the configured-worker artifact.",
    ].join("\n"),
  );
}
