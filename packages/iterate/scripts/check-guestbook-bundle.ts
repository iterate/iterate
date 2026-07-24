import { readFile } from "node:fs/promises";

const entrypoint = new URL("../dist/guestbook/configured-worker.mjs", import.meta.url);
const pending = [entrypoint];
const visited = new Set<string>();
const unsupported = new Set<string>();
let bundledSource = "";

while (pending.length > 0) {
  const moduleUrl = pending.pop()!;
  if (visited.has(moduleUrl.href)) continue;
  visited.add(moduleUrl.href);
  const source = await readFile(moduleUrl, "utf8");
  bundledSource += source;
  const specifiers = [
    ...source.matchAll(/^(?:import|export)\s+(?:[^"'\n]*?\sfrom\s+)?["']([^"']+)["'];?$/gm),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]!);

  for (const specifier of specifiers) {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      pending.push(new URL(specifier, moduleUrl));
    } else if (!specifier.startsWith("cloudflare:")) {
      unsupported.add(specifier);
    }
  }
}

if (unsupported.size > 0) {
  throw new Error(
    [
      "The configured Guestbook worker relies on packages its host does not install:",
      ...[...unsupported].toSorted().map((specifier) => `- ${specifier}`),
      "Bundle these dependencies into the configured-worker artifact.",
    ].join("\n"),
  );
}

for (const requiredSource of [
  "Guestbook connection is not ready",
  "guestbook/subscription-removed:v2",
]) {
  if (!bundledSource.includes(requiredSource)) {
    throw new Error(
      `The configured Guestbook worker is missing ${JSON.stringify(requiredSource)}.`,
    );
  }
}
