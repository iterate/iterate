import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCli } from "trpc-cli";
import { build as tsdown } from "tsdown";

type BundleManifestEntry = {
  allowedImports: string[];
  allowedImportPrefixes: string[];
  entrypoint: URL;
  followRelativeImports: boolean;
  name: string;
  requiredSource: string[];
  target: "browser" | "physical-worker";
};

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = fileURLToPath(new URL("../dist", import.meta.url));

export default async function build(): Promise<void> {
  await rm(distRoot, { force: true, recursive: true });

  await tsdown({ config: "tsdown.app-clients.config.ts", cwd: packageRoot });
  await checkClientBundles();

  await tsdown({ config: "tsdown.config.ts", cwd: packageRoot });
  await checkPhysicalWorkerBundles();

  await runPhase("emit declarations", ["exec", "tsc", "-p", "tsconfig.sdk.json"]);
}

async function runPhase(name: string, args: string[]): Promise<void> {
  console.log(`\n[iterate build] ${name}`);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const child = spawn("pnpm", args, { cwd: packageRoot, stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  if (result.signal !== null) {
    throw new Error(`pnpm ${args.join(" ")} terminated by ${result.signal}`);
  }
  if (result.code !== 0) {
    throw new Error(`pnpm ${args.join(" ")} exited with code ${result.code}`);
  }
}

const clientBundles: BundleManifestEntry[] = [
  {
    allowedImports: [],
    allowedImportPrefixes: [],
    entrypoint: new URL("../dist/starter-apps/guestbook/client.mjs", import.meta.url),
    followRelativeImports: false,
    name: "Guestbook browser asset",
    requiredSource: [],
    target: "browser",
  },
  {
    allowedImports: [],
    allowedImportPrefixes: [],
    entrypoint: new URL("../dist/starter-apps/todo/client.mjs", import.meta.url),
    followRelativeImports: false,
    name: "Todo browser asset",
    requiredSource: [],
    target: "browser",
  },
];

const physicalWorkerBundles: BundleManifestEntry[] = [
  {
    allowedImports: ["iterate:github-ai-linter-config"],
    allowedImportPrefixes: ["cloudflare:"],
    entrypoint: new URL(
      "../dist/starter-apps/github-ai-linter/configured-worker.mjs",
      import.meta.url,
    ),
    followRelativeImports: true,
    name: "configured GitHub AI linter worker",
    requiredSource: [],
    target: "physical-worker",
  },
  {
    allowedImports: [],
    allowedImportPrefixes: ["cloudflare:"],
    entrypoint: new URL("../dist/starter-apps/guestbook/configured-worker.mjs", import.meta.url),
    followRelativeImports: true,
    name: "configured Guestbook worker",
    requiredSource: ["Guestbook connection is not ready", "guestbook/created"],
    target: "physical-worker",
  },
  {
    allowedImports: [],
    allowedImportPrefixes: ["cloudflare:"],
    entrypoint: new URL("../dist/starter-apps/todo/configured-worker.mjs", import.meta.url),
    followRelativeImports: true,
    name: "configured Todo worker",
    requiredSource: ["New todo", "20260718000001_create_todos"],
    target: "physical-worker",
  },
];

async function checkBundle(bundle: BundleManifestEntry): Promise<void> {
  const pending = [bundle.entrypoint];
  const visited = new Set<string>();
  const unsupported = new Set<string>();
  let bundledSource = "";

  while (pending.length > 0) {
    const moduleUrl = pending.pop()!;
    if (visited.has(moduleUrl.href)) continue;
    visited.add(moduleUrl.href);
    const source = await readFile(moduleUrl, "utf8");
    bundledSource += source;

    for (const specifier of importSpecifiers(source)) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (relative && bundle.followRelativeImports) {
        pending.push(new URL(specifier, moduleUrl));
      } else if (
        !bundle.allowedImports.includes(specifier) &&
        !bundle.allowedImportPrefixes.some((prefix) => specifier.startsWith(prefix))
      ) {
        unsupported.add(specifier);
      }
    }
  }

  if (unsupported.size > 0) {
    const unavailable =
      bundle.target === "browser"
        ? "imports a browser cannot resolve"
        : "packages its host does not install";
    throw new Error(
      [
        `The ${bundle.name} relies on ${unavailable}:`,
        ...[...unsupported].toSorted().map((specifier) => `- ${specifier}`),
        bundle.target === "browser"
          ? `Bundle these dependencies into the ${bundle.name}.`
          : "Bundle these dependencies into the configured-worker artifact.",
      ].join("\n"),
    );
  }

  for (const requiredSource of bundle.requiredSource) {
    if (!bundledSource.includes(requiredSource)) {
      throw new Error(`The ${bundle.name} is missing ${JSON.stringify(requiredSource)}.`);
    }
  }
}

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/^(?:import|export)\s+(?:[^"'\n]*?\sfrom\s+)?["']([^"']+)["'];?$/gm),
    ...source.matchAll(/^(?:import|export)(?:[^"'\n]*?from)?["']([^"']+)["'];?$/gm),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]!);
}

export async function checkClientBundles(): Promise<void> {
  for (const bundle of clientBundles) await checkBundle(bundle);
}

export async function checkPhysicalWorkerBundles(): Promise<void> {
  for (const bundle of physicalWorkerBundles) await checkBundle(bundle);
}

void createCli({ ...import.meta, name: "build" }).run();
